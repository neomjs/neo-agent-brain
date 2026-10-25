/**
 * @module ai/services/fleet/socialPlatformClient
 * @summary HTTP platform adapters for X API v2 and LinkedIn Community Management API.
 * Uploads verified in-memory `media[].bytes` buffers directly without re-reading URIs from disk.
 */

import {
    PUBLISH_CHANNELS,
    REFUSAL_CODES,
    scrubSecrets
} from './fleetCustodyStore.mjs';

/**
 * Default number of recent account posts inspected during post-crash reconciliation.
 * @type {Number}
 */
export const RECONCILE_RECENT_POSTS_LIMIT = 20;

/**
 * @summary Creates the HTTP platform client for X API v2 and LinkedIn Community Management API.
 * Uploads verified `media[].bytes` buffers directly without re-reading URIs from disk.
 * @param {Object}   [options={}]
 * @param {Function} [options.fetch=globalThis.fetch]
 * @param {Object}   [options.custody=null]
 * @param {String}   [options.xBaseUrl='https://api.x.com/2']
 * @param {String}   [options.xUploadUrl='https://api.x.com/2/media/upload']
 * @param {String}   [options.linkedinBaseUrl='https://api.linkedin.com/rest']
 * @param {String}   [options.linkedinVersion='202604']
 * @param {Function} [options.now=Date.now]
 * @returns {{publishPost: Function, listRecentPosts: Function, readMetrics: Function, verifyOwnedPost: Function}}
 */
export function createSocialPlatformClient({
    fetch           = globalThis.fetch,
    custody         = null,
    xBaseUrl        = 'https://api.x.com/2',
    xUploadUrl      = 'https://api.x.com/2/media/upload',
    linkedinBaseUrl = 'https://api.linkedin.com/rest',
    linkedinVersion = '202604',
    now             = () => Date.now()
} = {}) {
    const cleanXBase        = xBaseUrl.replace(/\/+$/, ''),
          cleanLinkedinBase = linkedinBaseUrl.replace(/\/+$/, '');

    function assertFetchAvailable(secrets = []) {
        if (typeof fetch !== 'function') {
            const err = new Error(scrubSecrets('platform HTTP fetch implementation is not available', secrets));
            err.refused = true;
            err.code    = 'refused: platform';
            throw err;
        }
    }

    function linkedinHeaders(token, extra = {}) {
        return {
            Authorization              : `Bearer ${token}`,
            'LinkedIn-Version'         : linkedinVersion,
            'X-Restli-Protocol-Version': '2.0.0',
            ...extra
        };
    }

    function normalizeLinkedinAuthorUrn(account) {
        const trimmed = String(account ?? '').trim();
        return trimmed.startsWith('urn:li:') ? trimmed : `urn:li:organization:${trimmed}`;
    }

    async function parseJsonSafe(response) {
        if (typeof response?.json === 'function') {
            try {
                return await response.json();
            } catch {
                return null;
            }
        }
        if (typeof response?.text === 'function') {
            try {
                const text = await response.text();
                return text ? JSON.parse(text) : null;
            } catch {
                return null;
            }
        }
        return null;
    }

    async function uploadXMediaItems(mediaItems, token) {
        const mediaIds = [];
        for (const item of (mediaItems ?? [])) {
            if (!Buffer.isBuffer(item?.bytes) && !(item?.bytes instanceof Uint8Array)) {
                const err = new Error('verified media bytes buffer is required for X media upload');
                err.refused = true;
                err.code    = REFUSAL_CODES.digest;
                throw err;
            }
            const bytesBuffer = Buffer.isBuffer(item.bytes) ? item.bytes : Buffer.from(item.bytes),
                  uploadRes   = await fetch(xUploadUrl, {
                      method : 'POST',
                      headers: {
                          Authorization : `Bearer ${token}`,
                          'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({
                          media         : bytesBuffer.toString('base64'),
                          media_type    : item.mimeType || 'application/octet-stream',
                          media_category: 'tweet_image'
                      })
                  }),
                  uploadJson  = await parseJsonSafe(uploadRes);

            if (!uploadRes?.ok) {
                const err = new Error(scrubSecrets(`X media upload failed (HTTP ${uploadRes?.status ?? 'unknown'})`, [token]));
                err.refused = true;
                err.code    = 'refused: platform';
                throw err;
            }

            const mediaId = uploadJson?.data?.id ?? uploadJson?.media_id_string ?? uploadJson?.media_id ?? null;
            if (!mediaId) {
                const err = new Error('X media upload response did not include a media id');
                err.refused = true;
                err.code    = 'refused: platform';
                throw err;
            }
            mediaIds.push(String(mediaId));
        }
        return mediaIds;
    }

    async function uploadLinkedinMediaItems(mediaItems, authorUrn, token) {
        const imageUrns = [];
        for (const item of (mediaItems ?? [])) {
            if (!Buffer.isBuffer(item?.bytes) && !(item?.bytes instanceof Uint8Array)) {
                const err = new Error('verified media bytes buffer is required for LinkedIn image upload');
                err.refused = true;
                err.code    = REFUSAL_CODES.digest;
                throw err;
            }
            const bytesBuffer = Buffer.isBuffer(item.bytes) ? item.bytes : Buffer.from(item.bytes),
                  initRes     = await fetch(`${cleanLinkedinBase}/images?action=initializeUpload`, {
                      method : 'POST',
                      headers: linkedinHeaders(token, {'Content-Type': 'application/json'}),
                      body   : JSON.stringify({
                          initializeUploadRequest: {owner: authorUrn}
                      })
                  }),
                  initJson    = await parseJsonSafe(initRes);

            if (!initRes?.ok) {
                const err = new Error(scrubSecrets(`LinkedIn image initializeUpload failed (HTTP ${initRes?.status ?? 'unknown'})`, [token]));
                err.refused = true;
                err.code    = 'refused: platform';
                throw err;
            }

            const uploadUrl = initJson?.value?.uploadUrl ?? null,
                  imageUrn  = initJson?.value?.image ?? null;

            if (!uploadUrl || !imageUrn) {
                const err = new Error('LinkedIn initializeUpload response omitted uploadUrl or image URN');
                err.refused = true;
                err.code    = 'refused: platform';
                throw err;
            }

            const putRes = await fetch(uploadUrl, {
                method : 'PUT',
                headers: {
                    Authorization : `Bearer ${token}`,
                    'Content-Type': item.mimeType || 'application/octet-stream'
                },
                body: bytesBuffer
            });

            if (!putRes?.ok) {
                const err = new Error(scrubSecrets(`LinkedIn image binary PUT failed (HTTP ${putRes?.status ?? 'unknown'})`, [token]));
                err.refused = true;
                err.code    = 'refused: platform';
                throw err;
            }

            imageUrns.push(String(imageUrn));
        }
        return imageUrns;
    }

    async function resolveXUserId(account, token) {
        const clean = String(account ?? '').trim().replace(/^@/, '');
        if (/^\d+$/.test(clean)) {
            return clean;
        }
        const userRes = await fetch(`${cleanXBase}/users/by/username/${encodeURIComponent(clean)}`, {
                  method : 'GET',
                  headers: {Authorization: `Bearer ${token}`}
              }),
              userJson = await parseJsonSafe(userRes),
              userId   = userJson?.data?.id ?? null;

        if (!userRes?.ok || !userId) {
            throw new Error(scrubSecrets(`Unable to resolve X user id for @${clean} (HTTP ${userRes?.status ?? 'unknown'})`, [token]));
        }
        return String(userId);
    }

    return {
        /**
         * @summary Dispatches a post to X v2 or LinkedIn Community Management API using verified
         * in-memory `media[].bytes` and fetches the platform read-back record.
         */
        async publishPost({
            channel,
            account,
            token,
            text,
            inReplyTo = null,
            media     = []
        }) {
            const secrets = [token].filter(Boolean);
            assertFetchAvailable(secrets);

            if (channel === PUBLISH_CHANNELS.x) {
                const mediaIds = await uploadXMediaItems(media, token),
                      postBody = {text};

                if (inReplyTo) {
                    postBody.reply = {in_reply_to_tweet_id: String(inReplyTo)};
                }
                if (mediaIds.length > 0) {
                    postBody.media = {media_ids: mediaIds};
                }

                const postRes = await fetch(`${cleanXBase}/tweets`, {
                    method : 'POST',
                    headers: {
                        Authorization : `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(postBody)
                });
                const postJson = await parseJsonSafe(postRes);

                if (!postRes?.ok) {
                    const detail = postJson?.detail || postJson?.title || `HTTP ${postRes?.status ?? 'unknown'}`,
                          err    = new Error(scrubSecrets(`X post creation failed: ${detail}`, secrets));
                    if (postRes?.status && postRes.status >= 400 && postRes.status < 500 && postRes.status !== 429) {
                        err.refused = true;
                        err.code    = 'refused: platform';
                    }
                    throw err;
                }

                const providerId = postJson?.data?.id ?? postJson?.id ?? null;
                if (!providerId) {
                    throw new Error('X post creation returned no tweet id');
                }

                let readbackData = null;
                try {
                    const readRes = await fetch(`${cleanXBase}/tweets/${encodeURIComponent(String(providerId))}?tweet.fields=created_at,author_id,text,public_metrics`, {
                        method : 'GET',
                        headers: {Authorization: `Bearer ${token}`}
                    });
                    if (readRes?.ok) {
                        const readJson = await parseJsonSafe(readRes);
                        readbackData = readJson?.data ?? readJson ?? null;
                    }
                } catch {
                    // Fall back to post creation response payload when immediate read-back is unavailable.
                }

                const readbackAt = new Date(now()).toISOString(),
                      createdAt  = readbackData?.created_at ?? postJson?.data?.created_at ?? readbackAt,
                      readText   = typeof readbackData?.text === 'string'
                          ? readbackData.text
                          : (typeof postJson?.data?.text === 'string' ? postJson.data.text : text);

                return {
                    providerId: String(providerId),
                    createdAt,
                    readbackAt,
                    readback  : {
                        providerId: String(providerId),
                        text      : readText,
                        createdAt,
                        readbackAt
                    }
                };
            }

            if (channel === PUBLISH_CHANNELS.linkedin) {
                const authorUrn = normalizeLinkedinAuthorUrn(account),
                      imageUrns = await uploadLinkedinMediaItems(media, authorUrn, token),
                      postBody  = {
                          author      : authorUrn,
                          commentary  : text,
                          visibility  : 'PUBLIC',
                          distribution: {
                              feedDistribution              : 'MAIN_FEED',
                              targetEntities                : [],
                              thirdPartyDistributionChannels: []
                          },
                          lifecycleState           : 'PUBLISHED',
                          isReshareDisabledByAuthor: false
                      };

                if (imageUrns.length === 1) {
                    postBody.content = {media: {id: imageUrns[0]}};
                } else if (imageUrns.length > 1) {
                    postBody.content = {multiImage: {images: imageUrns.map(id => ({id}))}};
                }

                const postRes = await fetch(`${cleanLinkedinBase}/posts`, {
                    method : 'POST',
                    headers: linkedinHeaders(token, {'Content-Type': 'application/json'}),
                    body   : JSON.stringify(postBody)
                });
                const postJson = await parseJsonSafe(postRes);

                if (!postRes?.ok) {
                    const detail = postJson?.message || `HTTP ${postRes?.status ?? 'unknown'}`,
                          err    = new Error(scrubSecrets(`LinkedIn post creation failed: ${detail}`, secrets));
                    if (postRes?.status && postRes.status >= 400 && postRes.status < 500 && postRes.status !== 429) {
                        err.refused = true;
                        err.code    = 'refused: platform';
                    }
                    throw err;
                }

                const headerId   = typeof postRes?.headers?.get === 'function' ? postRes.headers.get('x-restli-id') : null,
                      providerId = headerId ?? postJson?.id ?? postJson?.urn ?? null;

                if (!providerId) {
                    throw new Error('LinkedIn post creation returned no post URN/id');
                }

                let readbackData = null;
                try {
                    const readRes = await fetch(`${cleanLinkedinBase}/posts/${encodeURIComponent(String(providerId))}`, {
                        method : 'GET',
                        headers: linkedinHeaders(token)
                    });
                    if (readRes?.ok) {
                        readbackData = await parseJsonSafe(readRes);
                    }
                } catch {
                    // Fall back to post creation response when immediate read-back is unavailable.
                }

                const readbackAt = new Date(now()).toISOString(),
                      rawCreated = readbackData?.publishedAt ?? readbackData?.createdAt ?? postJson?.publishedAt ?? null,
                      createdAt  = typeof rawCreated === 'number'
                          ? new Date(rawCreated).toISOString()
                          : (typeof rawCreated === 'string' ? rawCreated : readbackAt),
                      readText   = typeof readbackData?.commentary === 'string'
                          ? readbackData.commentary
                          : (typeof postJson?.commentary === 'string' ? postJson.commentary : text);

                return {
                    providerId: String(providerId),
                    createdAt,
                    readbackAt,
                    readback  : {
                        providerId: String(providerId),
                        text      : readText,
                        createdAt,
                        readbackAt
                    }
                };
            }

            const err = new Error(`Unsupported platform channel '${String(channel)}'`);
            err.refused = true;
            err.code    = REFUSAL_CODES.channel;
            throw err;
        },

        /**
         * @summary Lists recent posts on `{channel, account}` with `createdAt` timestamps for
         * post-crash reconciliation bounded by `reservedAt`.
         */
        async listRecentPosts({channel, account, token, limit = RECONCILE_RECENT_POSTS_LIMIT}) {
            const secrets = [token].filter(Boolean);
            assertFetchAvailable(secrets);

            if (channel === PUBLISH_CHANNELS.x) {
                const userId     = await resolveXUserId(account, token),
                      clampLimit = Math.min(Math.max(Number(limit) || RECONCILE_RECENT_POSTS_LIMIT, 5), 100),
                      res        = await fetch(`${cleanXBase}/users/${encodeURIComponent(userId)}/tweets?max_results=${clampLimit}&tweet.fields=created_at,text,conversation_id`, {
                          method : 'GET',
                          headers: {Authorization: `Bearer ${token}`}
                      }),
                      json       = await parseJsonSafe(res);

                if (!res?.ok) {
                    throw new Error(scrubSecrets(`X listRecentPosts failed (HTTP ${res?.status ?? 'unknown'})`, secrets));
                }

                const items = Array.isArray(json?.data) ? json.data : [];
                return items.map(item => ({
                    id        : String(item.id),
                    providerId: String(item.id),
                    text      : item.text ?? '',
                    createdAt : item.created_at ?? item.createdAt ?? null
                }));
            }

            if (channel === PUBLISH_CHANNELS.linkedin) {
                const authorUrn = normalizeLinkedinAuthorUrn(account),
                      res       = await fetch(`${cleanLinkedinBase}/posts?author=${encodeURIComponent(authorUrn)}&q=author&count=${Number(limit) || RECONCILE_RECENT_POSTS_LIMIT}`, {
                          method : 'GET',
                          headers: linkedinHeaders(token)
                      }),
                      json      = await parseJsonSafe(res);

                if (!res?.ok) {
                    throw new Error(scrubSecrets(`LinkedIn listRecentPosts failed (HTTP ${res?.status ?? 'unknown'})`, secrets));
                }

                const elements = Array.isArray(json?.elements) ? json.elements : (Array.isArray(json?.data) ? json.data : []);
                return elements.map(item => {
                    const rawCreated = item.publishedAt ?? item.createdAt ?? null,
                          createdAt  = typeof rawCreated === 'number'
                              ? new Date(rawCreated).toISOString()
                              : (typeof rawCreated === 'string' ? rawCreated : null),
                          id         = String(item.id ?? item.urn ?? '');
                    return {
                        id,
                        providerId: id,
                        text      : item.commentary ?? item.text ?? '',
                        createdAt
                    };
                });
            }

            throw new Error(`Unsupported platform channel '${String(channel)}'`);
        },

        /**
         * @summary Reads owned-object metrics (`public_metrics` + `non_public_metrics` on X, or
         * organizational share statistics on LinkedIn).
         */
        async readMetrics({providerId, channel, account, token}) {
            const secrets = [token].filter(Boolean);
            assertFetchAvailable(secrets);

            if (channel === PUBLISH_CHANNELS.x) {
                const res = await fetch(`${cleanXBase}/tweets/${encodeURIComponent(String(providerId))}?tweet.fields=public_metrics,non_public_metrics,created_at`, {
                          method : 'GET',
                          headers: {Authorization: `Bearer ${token}`}
                      }),
                      json = await parseJsonSafe(res);

                if (!res?.ok) {
                    throw new Error(scrubSecrets(`X readMetrics failed (HTTP ${res?.status ?? 'unknown'})`, secrets));
                }

                const data = json?.data ?? json ?? {};
                return {
                    source            : 'x-v2-owned-object-metrics',
                    window            : '30d',
                    claimClass        : 'owned-object-telemetry',
                    public_metrics    : data.public_metrics ?? {},
                    non_public_metrics: data.non_public_metrics ?? {}
                };
            }

            if (channel === PUBLISH_CHANNELS.linkedin) {
                const authorUrn = normalizeLinkedinAuthorUrn(account),
                      res       = await fetch(`${cleanLinkedinBase}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(authorUrn)}&shares=List(${encodeURIComponent(String(providerId))})`, {
                          method : 'GET',
                          headers: linkedinHeaders(token)
                      }),
                      json      = await parseJsonSafe(res);

                if (!res?.ok) {
                    throw new Error(scrubSecrets(`LinkedIn readMetrics failed (HTTP ${res?.status ?? 'unknown'})`, secrets));
                }

                const rawStats   = json?.elements?.[0]?.totalShareStatistics ?? json?.totalShareStatistics ?? json?.statistics ?? {},
                      aliasKeys  = new Set(['impressionCount', 'uniqueImpressionsCount', 'clickCount', 'likeCount', 'commentCount', 'shareCount']),
                      statistics = {};

                for (const [k, v] of Object.entries(rawStats)) {
                    if (!aliasKeys.has(k)) {
                        statistics[k] = v;
                    }
                }
                if (rawStats.impressionCount !== undefined && statistics.impressions === undefined) {
                    statistics.impressions = rawStats.impressionCount;
                }
                if (rawStats.uniqueImpressionsCount !== undefined && statistics.uniqueImpressions === undefined) {
                    statistics.uniqueImpressions = rawStats.uniqueImpressionsCount;
                }
                if (rawStats.clickCount !== undefined && statistics.clicks === undefined) {
                    statistics.clicks = rawStats.clickCount;
                }
                if (rawStats.likeCount !== undefined && statistics.likes === undefined) {
                    statistics.likes = rawStats.likeCount;
                }
                if (rawStats.commentCount !== undefined && statistics.comments === undefined) {
                    statistics.comments = rawStats.commentCount;
                }
                if (rawStats.shareCount !== undefined && statistics.shares === undefined) {
                    statistics.shares = rawStats.shareCount;
                }

                return {
                    source    : 'linkedin-community-management-api',
                    window    : 'lifetime',
                    claimClass: 'owned-object-telemetry',
                    statistics
                };
            }

            throw new Error(`Unsupported platform channel '${String(channel)}'`);
        },

        /**
         * @summary Verifies that `providerId` is an owned post of `{channel, account}` before
         * permitting a same-account `link-reply`. Fails closed (`false`) on any mismatch or error.
         */
        async verifyOwnedPost({channel, account, providerId, token: suppliedToken = null}) {
            if (!channel || !account || !providerId || typeof fetch !== 'function') {
                return false;
            }

            let token = suppliedToken;
            if (!token && typeof custody?.readCredential === 'function') {
                const cred = await custody.readCredential({channel, account, nowMs: now()});
                if (cred?.ok && cred.token) {
                    token = cred.token;
                }
            }
            if (!token) {
                return false;
            }

            try {
                if (channel === PUBLISH_CHANNELS.x) {
                    const res = await fetch(`${cleanXBase}/tweets/${encodeURIComponent(String(providerId))}?expansions=author_id&user.fields=username`, {
                              method : 'GET',
                              headers: {Authorization: `Bearer ${token}`}
                          }),
                          json = await parseJsonSafe(res);

                    if (!res?.ok) {
                        return false;
                    }

                    const expectedAccount = String(account).trim().replace(/^@/, '').toLowerCase(),
                          authorId        = json?.data?.author_id ?? null,
                          users           = Array.isArray(json?.includes?.users) ? json.includes.users : [],
                          authorUser      = users.find(u => String(u.id) === String(authorId)) ?? users[0] ?? null,
                          username        = authorUser?.username ? String(authorUser.username).trim().replace(/^@/, '').toLowerCase() : null;

                    if (username && username === expectedAccount) {
                        return true;
                    }
                    if (authorId && String(authorId).toLowerCase() === expectedAccount) {
                        return true;
                    }
                    return false;
                }

                if (channel === PUBLISH_CHANNELS.linkedin) {
                    const expectedUrn = normalizeLinkedinAuthorUrn(account),
                          res         = await fetch(`${cleanLinkedinBase}/posts/${encodeURIComponent(String(providerId))}`, {
                              method : 'GET',
                              headers: linkedinHeaders(token)
                          }),
                          json        = await parseJsonSafe(res);

                    if (!res?.ok || !json) {
                        return false;
                    }

                    return String(json.author ?? '') === expectedUrn;
                }
            } catch {
                return false;
            }

            return false;
        }
    };
}
