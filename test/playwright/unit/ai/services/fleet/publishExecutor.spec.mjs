import crypto         from 'node:crypto';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {expect, test} from '@playwright/test';
import {
    LINKEDIN_TOKEN_MAX_AGE_MS,
    PUBLICATION_STATES,
    PUBLISH_CHANNELS,
    PUBLISH_FORMATS,
    REFUSAL_CODES,
    REPLY_CLASSIFICATION_PRIMARY_SOURCE,
    SWITCH_STATES,
    computePublishRevisionDigest,
    createFleetCustodyStore,
    createPublishExecutor,
    publish,
    readMetrics,
    reply
} from '../../../../../../ai/services/fleet/publishExecutor.mjs';

const NOW_MS  = Date.UTC(2026, 9, 25, 2, 0, 0);
const REQ_ID  = 'MESSAGE:97900000-0000-4000-8000-000000000001';
const PEER_ID = '@neo-fable-clio';
const SECRET  = 'x-oauth2-pkce-super-secret-token-99887766';

function buildPayload(overrides = {}) {
    return {
        schemaVersion: 1,
        channel      : PUBLISH_CHANNELS.x,
        account      : '@neomjs',
        text         : 'Neo v13.2 ships the two-hemisphere Agent OS and Fleet publish gate.',
        media        : [],
        hypothesis   : 'Founder-grade architecture posts with concrete receipts earn higher repo click-through.',
        format       : PUBLISH_FORMATS.post,
        inReplyTo    : null,
        ...overrides
    };
}

function createInMemoryMailbox(initialRequests = {}, reviewMessages = {}) {
    const store       = new Map(Object.entries(initialRequests));
    const transitions = [];

    return {
        store,
        transitions,
        async getRequest(requestId) {
            const record = store.get(requestId);
            return record ? structuredClone(record) : null;
        },
        async getReviewMessage(messageId) {
            return reviewMessages[messageId] ? structuredClone(reviewMessages[messageId]) : null;
        },
        async recordPublicationState(update) {
            transitions.push(structuredClone(update));
            const existing = store.get(update.requestId);
            if (!existing) {
                return {ok: false, refused: REFUSAL_CODES.notFound};
            }

            if (update.expectedState && existing.publication.state !== update.expectedState) {
                return {
                    ok     : false,
                    state  : existing.publication.state,
                    refused: REFUSAL_CODES.publishingInFlight,
                    reason : `expected state ${update.expectedState}, found ${existing.publication.state}`
                };
            }

            existing.publication = {
                ...existing.publication,
                state          : update.state,
                attemptId      : update.attemptId ?? existing.publication.attemptId ?? null,
                revisionNumber : update.revisionNumber ?? existing.publication.revisionNumber ?? 1,
                revisionDigest : update.revisionDigest ?? existing.publication.revisionDigest,
                providerId     : update.providerId ?? existing.publication.providerId ?? null,
                readback       : update.readback ?? existing.publication.readback ?? null,
                readbackAt     : update.readbackAt ?? existing.publication.readbackAt ?? null,
                textAsRequested: update.textAsRequested ?? existing.publication.textAsRequested,
                textAsPublished: update.textAsPublished !== undefined ? update.textAsPublished : existing.publication.textAsPublished,
                refusalReason  : update.refusalReason ?? null
            };
            store.set(update.requestId, existing);
            return {ok: true, publication: structuredClone(existing.publication)};
        }
    };
}

function seedApprovedRequest({
    requestId    = REQ_ID,
    requester    = PEER_ID,
    payload      = buildPayload(),
    approved     = true,
    releaseState = null,
    attestation  = null,
    textInitial  = null
} = {}) {
    const revisionDigest = computePublishRevisionDigest(payload);
    const revision1Text  = textInitial ?? payload.text;
    const revisions      = [];

    if (textInitial && textInitial !== payload.text) {
        const rev1Payload = {...payload, text: textInitial};
        revisions.push({
            revisionNumber: 1,
            revisionDigest: computePublishRevisionDigest(rev1Payload),
            createdAt     : '2026-10-25T01:50:00.000Z',
            createdBy     : requester,
            payload       : rev1Payload,
            approval      : null,
            attestation   : null
        });
    }

    const revNum          = revisions.length + 1;
    const currentRevision = {
        revisionNumber: revNum,
        revisionDigest,
        createdAt     : '2026-10-25T01:55:00.000Z',
        createdBy     : revNum > 1 ? '@tobiu' : requester,
        payload,
        approval      : approved
            ? {
                approvedBy    : '@tobiu',
                approvedAt    : '2026-10-25T01:56:00.000Z',
                revisionNumber: revNum,
                revisionDigest
            }
            : null,
        attestation,
        releaseState
    };
    revisions.push(currentRevision);

    return {
        requestId,
        requester,
        revisions,
        currentRevision,
        publication: {
            state          : PUBLICATION_STATES.queued,
            attemptId      : null,
            revisionNumber : revNum,
            revisionDigest,
            providerId     : null,
            readback       : null,
            readbackAt     : null,
            textAsRequested: revision1Text,
            textAsPublished: null,
            refusalReason  : null
        }
    };
}

test.describe('publishExecutor (#979)', () => {
    test('AC-1: publish records publishing before the platform call and published with the provider id after it; a second call for the same id and digest is a no-op with the recorded provider id', async () => {
        const request = seedApprovedRequest({
            textInitial: 'Draft v1 before operator edit.',
            payload    : buildPayload({text: 'Edited & approved v2 body for X.'})
        });
        const digest  = request.currentRevision.revisionDigest;
        const mailbox = createInMemoryMailbox({[REQ_ID]: request});

        let   stateAtPlatformDispatch = null;
        const platformCalls           = [];

        const platform = {
            async publishPost(call) {
                platformCalls.push(call);
                stateAtPlatformDispatch = (await mailbox.getRequest(REQ_ID)).publication.state;
                return {
                    providerId: 'tweet-189900112233',
                    readback  : {
                        providerId: 'tweet-189900112233',
                        text      : call.text,
                        readbackAt: new Date(NOW_MS).toISOString()
                    }
                };
            }
        };

        const executor = createPublishExecutor({
            mailbox,
            credentials  : {'x:@neomjs': {accessToken: SECRET, expiresAt: NOW_MS + 3600_000}},
            switchStore  : {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform,
            now          : () => NOW_MS,
            mintAttemptId: () => 'attempt-ac1'
        });

        const first = await executor.publish(REQ_ID, digest);

        expect(stateAtPlatformDispatch).toBe(PUBLICATION_STATES.publishing);
        expect(mailbox.transitions.map(t => t.state)).toEqual([
            PUBLICATION_STATES.publishing,
            PUBLICATION_STATES.published
        ]);
        expect(first).toMatchObject({
            ok             : true,
            state          : PUBLICATION_STATES.published,
            noop           : false,
            reconciled     : false,
            requestId      : REQ_ID,
            attemptId      : 'attempt-ac1',
            revisionNumber : 2,
            revisionDigest : digest,
            providerId     : 'tweet-189900112233',
            textAsRequested: 'Draft v1 before operator edit.',
            textAsPublished: 'Edited & approved v2 body for X.'
        });
        expect(platformCalls).toHaveLength(1);

        // Second call for the same id and digest is an idempotent no-op with the recorded providerId
        const second = await executor.publish(REQ_ID, digest);
        expect(second).toMatchObject({
            ok             : true,
            state          : PUBLICATION_STATES.published,
            noop           : true,
            requestId      : REQ_ID,
            revisionDigest : digest,
            providerId     : 'tweet-189900112233',
            textAsRequested: 'Draft v1 before operator edit.',
            textAsPublished: 'Edited & approved v2 body for X.'
        });
        expect(platformCalls).toHaveLength(1);

        // A call with a different digest on an already-published request is refused without calling the platform
        const differentDigest = await executor.publish(REQ_ID, '0'.repeat(64));
        expect(differentDigest).toMatchObject({
            ok        : false,
            state     : PUBLICATION_STATES.published,
            refused   : REFUSAL_CODES.alreadyPublished,
            providerId: 'tweet-189900112233'
        });
        expect(platformCalls).toHaveLength(1);
    });

    test('AC-2: a crash between the platform call and the published record leaves publishing; the next run reconciles against recent posts and records published without a second post, or unresolved when it cannot tell', async () => {
        // Arm A: positive reconciliation match adopts providerId and records `published` without a second post
        const reqA     = seedApprovedRequest();
        const digestA  = reqA.currentRevision.revisionDigest;
        const mailboxA = createInMemoryMailbox({[REQ_ID]: reqA});

        let publishCallsA = 0;
        let recentCallsA  = 0;

        const executorA = createPublishExecutor({
            mailbox      : mailboxA,
            credentials  : {'x:@neomjs': {accessToken: SECRET, expiresAt: NOW_MS + 3600_000}},
            switchStore  : {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            now          : () => NOW_MS,
            mintAttemptId: () => 'attempt-crash-a',
            platform     : {
                async publishPost() {
                    publishCallsA++;
                    throw new Error('ECONNRESET: socket hang up after platform accepted POST /2/tweets');
                },
                async listRecentPosts() {
                    recentCallsA++;
                    return [
                        {
                            id  : 'tweet-reconciled-777',
                            text: reqA.currentRevision.payload.text
                        }
                    ];
                }
            }
        });

        await expect(executorA.publish(REQ_ID, digestA)).rejects.toThrow(/publish dispatch interrupted after recording publishing/);
        expect((await mailboxA.getRequest(REQ_ID)).publication.state).toBe(PUBLICATION_STATES.publishing);
        expect(publishCallsA).toBe(1);

        const reconciled = await executorA.publish(REQ_ID, digestA);
        expect(reconciled).toMatchObject({
            ok            : true,
            state         : PUBLICATION_STATES.published,
            reconciled    : true,
            attemptId     : 'attempt-crash-a',
            revisionDigest: digestA,
            providerId    : 'tweet-reconciled-777'
        });
        expect(publishCallsA).toBe(1);
        expect(recentCallsA).toBe(1);
        expect((await mailboxA.getRequest(REQ_ID)).publication.state).toBe(PUBLICATION_STATES.published);

        // Arm B: when recent-posts read cannot locate the post, records `unresolved` without a second post and blocks bypass
        const reqB     = seedApprovedRequest({requestId: 'MESSAGE:97900000-0000-4000-8000-000000000002'});
        const digestB  = reqB.currentRevision.revisionDigest;
        const mailboxB = createInMemoryMailbox({[reqB.requestId]: reqB});

        let   publishCallsB = 0;
        const executorB     = createPublishExecutor({
            mailbox      : mailboxB,
            credentials  : {'x:@neomjs': {accessToken: SECRET, expiresAt: NOW_MS + 3600_000}},
            switchStore  : {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            now          : () => NOW_MS,
            mintAttemptId: () => 'attempt-crash-b',
            platform     : {
                async publishPost() {
                    publishCallsB++;
                    throw new Error('ETIMEDOUT waiting for platform response');
                },
                async listRecentPosts() {
                    return [];
                }
            }
        });

        await expect(executorB.publish(reqB.requestId, digestB)).rejects.toThrow(/publish dispatch interrupted/);
        expect((await mailboxB.getRequest(reqB.requestId)).publication.state).toBe(PUBLICATION_STATES.publishing);

        const unresolvedResult = await executorB.publish(reqB.requestId, digestB);
        expect(unresolvedResult).toMatchObject({
            ok            : false,
            state         : PUBLICATION_STATES.unresolved,
            refused       : REFUSAL_CODES.unresolved,
            attemptId     : 'attempt-crash-b',
            revisionDigest: digestB
        });
        expect(publishCallsB).toBe(1);
        expect((await mailboxB.getRequest(reqB.requestId)).publication.state).toBe(PUBLICATION_STATES.unresolved);

        // Subsequent attempts with the same or a different digest remain refused while `unresolved`
        const bypassAttempt = await executorB.publish(reqB.requestId, 'f'.repeat(64));
        expect(bypassAttempt).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.unresolved,
            refused: REFUSAL_CODES.unresolved
        });
        expect(publishCallsB).toBe(1);
    });

    test('AC-3: a revision digest that does not match the approval is refused; a switch state read at publish time below the request release state refuses the queued request', async () => {
        // Arm A: revision digest mismatch against approval is refused (`refused: digest`)
        const reqMismatch = seedApprovedRequest();
        reqMismatch.currentRevision.approval.revisionDigest = 'a'.repeat(64);
        const digestMismatch  = reqMismatch.currentRevision.revisionDigest;
        const mailboxMismatch = createInMemoryMailbox({[REQ_ID]: reqMismatch});

        let   platformCalled = false;
        const executor       = createPublishExecutor({
            mailbox    : mailboxMismatch,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { platformCalled = true; return {providerId: 'never'}; }}
        });

        const mismatchRes = await executor.publish(REQ_ID, digestMismatch);
        expect(mismatchRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.digest
        });
        expect(platformCalled).toBe(false);

        // Arm B: stale caller-passed digest that does not match currentRevision after an Edit is refused (`refused: digest`)
        const reqEdited     = seedApprovedRequest({textInitial: 'Initial draft', payload: buildPayload({text: 'Edited text'})});
        const staleDigest   = reqEdited.revisions[0].revisionDigest;
        const mailboxEdited = createInMemoryMailbox({[REQ_ID]: reqEdited});
        const staleRes      = await executor.publish(REQ_ID, staleDigest, {mailbox: mailboxEdited});
        expect(staleRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.digest
        });
        expect(platformCalled).toBe(false);

        // Arm C: switch state read at publish time downgraded below the queued request's release state refuses (`refused: switch`)
        const reqDowngraded = seedApprovedRequest({
            requestId   : 'MESSAGE:97900000-0000-4000-8000-000000000003',
            approved    : false,
            releaseState: SWITCH_STATES.autoApprove
        });
        const digestDowngraded  = reqDowngraded.currentRevision.revisionDigest;
        const mailboxDowngraded = createInMemoryMailbox({[reqDowngraded.requestId]: reqDowngraded});

        // Switch was downgraded from `auto-approve` to `approve each` before publish() ran
        const downgradedRes = await publish(reqDowngraded.requestId, digestDowngraded, {
            mailbox    : mailboxDowngraded,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {async publishPost() { platformCalled = true; return {providerId: 'never'}; }}
        });

        expect(downgradedRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.switch
        });
        expect(platformCalled).toBe(false);

        // Arm D: `auto-approve after a cross-family review attestation` verifies reviewer family via Fleet authority
        const payloadAttested = buildPayload({text: 'Cross-family attested post.'});
        const digestAttested  = computePublishRevisionDigest(payloadAttested);
        const reviewMsgId     = 'MESSAGE:97900000-0000-4000-8000-000000000099';
        const reqAttested     = seedApprovedRequest({
            requestId  : 'MESSAGE:97900000-0000-4000-8000-000000000004',
            payload    : payloadAttested,
            approved   : false,
            attestation: {reviewerMessageId: reviewMsgId, revisionDigest: digestAttested}
        });
        const mailboxAttested = createInMemoryMailbox(
            {[reqAttested.requestId]: reqAttested},
            {[reviewMsgId]: {messageId: reviewMsgId, from: '@neo-gpt-sophie', body: `Approved digest ${digestAttested}`}}
        );

        const attestedRes = await publish(reqAttested.requestId, digestAttested, {
            mailbox              : mailboxAttested,
            credentials          : {'x:@neomjs': {accessToken: SECRET}},
            switchStore          : {[`${PEER_ID}:x`]: SWITCH_STATES.autoApproveAttested},
            resolveIdentityFamily: async id => (id === PEER_ID ? 'claude' : 'gpt'),
            platform             : {async publishPost() { return {providerId: 'tweet-attested-1'}; }}
        });
        expect(attestedRes).toMatchObject({
            ok        : true,
            state     : PUBLICATION_STATES.published,
            providerId: 'tweet-attested-1'
        });

        // Arm E: media byte-digest mismatch at publish time is refused (`refused: digest`)
        const mediaBytes   = Buffer.from('original-approved-image-bytes', 'utf8');
        const mediaSha256  = crypto.createHash('sha256').update(mediaBytes).digest('hex');
        const reqWithMedia = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000005',
            payload  : buildPayload({
                media: [{uri: 'resources/post-card.png', sha256: mediaSha256, mimeType: 'image/png'}]
            })
        });
        const tamperedMediaRes = await publish(reqWithMedia.requestId, reqWithMedia.currentRevision.revisionDigest, {
            mailbox    : createInMemoryMailbox({[reqWithMedia.requestId]: reqWithMedia}),
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            mediaReader: async () => Buffer.from('tampered-bytes-on-disk', 'utf8'),
            platform   : {async publishPost() { return {providerId: 'never'}; }}
        });
        expect(tamperedMediaRes).toMatchObject({
            ok     : false,
            state  : PUBLICATION_STATES.refused,
            refused: REFUSAL_CODES.digest
        });
    });

    test('AC-4: no verb returns, logs or embeds a token; a missing, expired, or 60-day-expired LinkedIn token yields refused: credential', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-custody-979-'));
        const xCredDir = path.join(tempRoot, 'social-credentials', 'x');
        await fs.mkdir(xCredDir, {recursive: true});
        await fs.writeFile(
            path.join(xCredDir, '_neomjs.json'),
            JSON.stringify({accessToken: SECRET, refreshToken: 'refresh-secret-token-001122', expiresAt: NOW_MS + 60_000}),
            'utf8'
        );

        const logLines = [];
        const logger   = {
            info : entry => logLines.push(entry),
            warn : entry => logLines.push(entry),
            error: entry => logLines.push(entry)
        };

        try {
            const custody = createFleetCustodyStore({custodyDir: tempRoot, now: () => NOW_MS});
            const req     = seedApprovedRequest();
            const digest  = req.currentRevision.revisionDigest;
            const mailbox = createInMemoryMailbox({[REQ_ID]: req});

            const executor = createPublishExecutor({
                mailbox,
                custody,
                switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
                logger,
                now        : () => NOW_MS,
                platform   : {
                    async publishPost({token}) {
                        expect(token).toBe(SECRET);
                        return {
                            providerId: 'tweet-custody-1',
                            tokenLeak : SECRET,
                            readback  : {providerId: 'tweet-custody-1', text: req.currentRevision.payload.text}
                        };
                    },
                    async readMetrics({token}) {
                        expect(token).toBe(SECRET);
                        const err = new Error(`Platform upstream error with Bearer ${token} and raw ${SECRET}`);
                        throw err;
                    }
                }
            });

            const pubResult     = await executor.publish(REQ_ID, digest);
            const metricsResult = await executor.readMetrics('tweet-custody-1', {channel: 'x', account: '@neomjs'});
            const replyResult   = await executor.reply({inReplyTo: 'tweet-99'});

            // Missing credential yields `refused: credential`
            const reqMissing = seedApprovedRequest({
                requestId: 'MESSAGE:97900000-0000-4000-8000-000000000006',
                payload  : buildPayload({account: '@missing-account'})
            });
            const mailboxMissing = createInMemoryMailbox({[reqMissing.requestId]: reqMissing});
            const missingRes     = await executor.publish(reqMissing.requestId, reqMissing.currentRevision.revisionDigest, {
                mailbox: mailboxMissing
            });
            expect(missingRes).toMatchObject({
                ok     : false,
                state  : PUBLICATION_STATES.refused,
                refused: REFUSAL_CODES.credential
            });

            // Expired token yields `refused: credential`
            const reqExpired     = seedApprovedRequest({requestId: 'MESSAGE:97900000-0000-4000-8000-000000000007'});
            const mailboxExpired = createInMemoryMailbox({[reqExpired.requestId]: reqExpired});
            const expiredRes     = await executor.publish(reqExpired.requestId, reqExpired.currentRevision.revisionDigest, {
                mailbox: mailboxExpired,
                now    : () => NOW_MS + 120_000
            });
            expect(expiredRes).toMatchObject({
                ok     : false,
                state  : PUBLICATION_STATES.refused,
                refused: REFUSAL_CODES.credential
            });

            // LinkedIn 60-day token expiry yields `refused: credential`
            const liPayload = buildPayload({channel: PUBLISH_CHANNELS.linkedin, account: 'neomjs-org'});
            const reqLi     = seedApprovedRequest({
                requestId: 'MESSAGE:97900000-0000-4000-8000-000000000008',
                payload  : liPayload
            });
            const liCustody = createFleetCustodyStore({
                credentials: {
                    'linkedin:neomjs-org': {
                        accessToken: 'li-secret-token-60d',
                        issuedAt   : NOW_MS - LINKEDIN_TOKEN_MAX_AGE_MS
                    }
                },
                now: () => NOW_MS
            });
            const liRes = await executor.publish(reqLi.requestId, reqLi.currentRevision.revisionDigest, {
                mailbox    : createInMemoryMailbox({[reqLi.requestId]: reqLi}),
                custody    : liCustody,
                switchStore: {[`${PEER_ID}:linkedin`]: SWITCH_STATES.approveEach}
            });
            expect(liRes).toMatchObject({
                ok     : false,
                state  : PUBLICATION_STATES.refused,
                refused: REFUSAL_CODES.credential
            });

            // Negative log and return assertion: no return value, mailbox record, or log entry contains any secret
            const serializedEverything = JSON.stringify({
                pubResult,
                metricsResult,
                replyResult,
                missingRes,
                expiredRes,
                liRes,
                logLines,
                mailboxTransitions: mailbox.transitions
            });

            expect(serializedEverything).not.toContain(SECRET);
            expect(serializedEverything).not.toContain('refresh-secret-token-001122');
            expect(serializedEverything).not.toContain('li-secret-token-60d');
        } finally {
            await fs.rm(tempRoot, {recursive: true, force: true});
        }
    });

    test('AC-5: reply refuses with the unresolved-classification reason and names the primary source to verify; publish enforces the same gate on reply and unverified link-reply formats', async () => {
        const replyRes = await reply({inReplyTo: 'tweet-third-party-123'});
        expect(replyRes).toMatchObject({
            ok           : false,
            refused      : REFUSAL_CODES.replyClassificationUnresolved,
            primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE
        });
        expect(replyRes.reason).toContain(REPLY_CLASSIFICATION_PRIMARY_SOURCE);

        // `publish` also refuses `format: 'reply'`
        const reqReply = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000009',
            payload  : buildPayload({format: PUBLISH_FORMATS.reply, inReplyTo: 'tweet-third-party-123'})
        });
        const pubReplyRes = await publish(reqReply.requestId, reqReply.currentRevision.revisionDigest, {
            mailbox    : createInMemoryMailbox({[reqReply.requestId]: reqReply}),
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach}
        });
        expect(pubReplyRes).toMatchObject({
            ok           : false,
            state        : PUBLICATION_STATES.refused,
            refused      : REFUSAL_CODES.replyClassificationUnresolved,
            primarySource: REPLY_CLASSIFICATION_PRIMARY_SOURCE
        });

        // `publish` refuses `format: 'link-reply'` targeting an unverified or third-party post,
        // and allows `format: 'link-reply'` when targeting an already-published parent on the same account
        const parentId  = 'MESSAGE:97900000-0000-4000-8000-000000000010';
        const parentReq = seedApprovedRequest({requestId: parentId});
        parentReq.publication.state      = PUBLICATION_STATES.published;
        parentReq.publication.providerId = 'tweet-parent-owned-555';

        const validLinkReply = seedApprovedRequest({
            requestId: 'MESSAGE:97900000-0000-4000-8000-000000000011',
            payload  : buildPayload({
                format   : PUBLISH_FORMATS.linkReply,
                inReplyTo: parentId,
                text     : 'Read the full architecture guide: https://neomjs.com'
            })
        });

        const mailboxLink = createInMemoryMailbox({
            [parentId]                : parentReq,
            [validLinkReply.requestId]: validLinkReply
        });

        let   dispatchedInReplyTo = null;
        const okLinkReplyRes      = await publish(validLinkReply.requestId, validLinkReply.currentRevision.revisionDigest, {
            mailbox    : mailboxLink,
            credentials: {'x:@neomjs': {accessToken: SECRET}},
            switchStore: {[`${PEER_ID}:x`]: SWITCH_STATES.approveEach},
            platform   : {
                async publishPost(call) {
                    dispatchedInReplyTo = call.inReplyTo;
                    return {providerId: 'tweet-self-reply-556'};
                }
            }
        });

        expect(okLinkReplyRes).toMatchObject({
            ok        : true,
            state     : PUBLICATION_STATES.published,
            providerId: 'tweet-self-reply-556'
        });
        expect(dispatchedInReplyTo).toBe('tweet-parent-owned-555');
    });

    test('AC-6: readMetrics returns the owned object metrics with source, window and claim class; an unavailable metric is unknown, never zero', async () => {
        const xMetricsRes = await readMetrics('tweet-189900112233', {
            channel    : PUBLISH_CHANNELS.x,
            account    : '@neomjs',
            credentials: {'x:@neomjs': {accessToken: SECRET, expiresAt: NOW_MS + 3600_000}},
            now        : () => NOW_MS,
            platform   : {
                async readMetrics({providerId, channel, account}) {
                    expect(providerId).toBe('tweet-189900112233');
                    expect(channel).toBe('x');
                    expect(account).toBe('@neomjs');
                    return {
                        source        : 'x-v2-owned-object-metrics',
                        window        : '30d',
                        claimClass    : 'owned-object-telemetry',
                        public_metrics: {
                            impressions: 1420,
                            likes      : 38,
                            reposts    : 9,
                            replies    : 0
                        },
                        non_public_metrics: {
                            url_link_clicks    : 64,
                            // user_profile_clicks and engagements intentionally omitted / unavailable
                            user_profile_clicks: null
                        }
                    };
                }
            }
        });

        expect(xMetricsRes).toEqual({
            ok        : true,
            providerId: 'tweet-189900112233',
            channel   : 'x',
            account   : '@neomjs',
            source    : 'x-v2-owned-object-metrics',
            window    : '30d',
            claimClass: 'owned-object-telemetry',
            metrics   : {
                impressions        : 1420,
                likes              : 38,
                reposts            : 9,
                replies            : 0,
                quotes             : 'unknown',
                bookmarks          : 'unknown',
                url_link_clicks    : 64,
                user_profile_clicks: 'unknown',
                engagements        : 'unknown'
            }
        });
    });
});
