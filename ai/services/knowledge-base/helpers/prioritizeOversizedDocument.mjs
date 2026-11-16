import * as acorn from 'acorn';

const STOP_WORDS = new Set([
    'about', 'after', 'all', 'also', 'and', 'any', 'are', 'can', 'does', 'for', 'from',
    'has', 'have', 'how', 'into', 'its', 'list', 'more', 'not', 'only', 'our', 'should',
    'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'what',
    'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'your'
]);

const CODE_EXTENSION_RE = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i;
const DOC_EXTENSION_RE  = /\.(?:md|mdx|markdown)$/i;

/**
 * @summary Breaks an identifier into camelCase and snake_case lowercased sub-tokens.
 * @param {String} token
 * @returns {String[]}
 * @private
 */
function splitIdentifierTokens(token) {
    return token
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[_\s$]+/)
        .map(part => part.toLowerCase())
        .filter(part => part.length > 2 && !STOP_WORDS.has(part));
}

/**
 * @summary Builds weighted query identifiers, subword stems, and retrieved chunk snippets.
 * @param {String} query
 * @param {String} embeddedContent
 * @returns {{exactTokens: String[], subWords: String[], chunkSnippets: String[]}}
 * @private
 */
function extractQuerySignals(query, embeddedContent) {
    const
        rawTokens  = String(query || '').match(/[a-zA-Z0-9_$]{3,}/g) || [],
        exactSet   = new Set(),
        subWordSet = new Set(),
        chunkSet   = new Set();

    for (const raw of rawTokens) {
        const lower = raw.toLowerCase();

        if (!STOP_WORDS.has(lower) && !/^\d+$/.test(lower)) {
            if (/[A-Z_]/.test(raw) || raw.length >= 6) {
                exactSet.add(lower);
            }
            subWordSet.add(lower);
        }

        for (const sub of splitIdentifierTokens(raw)) {
            subWordSet.add(sub);
        }
    }

    if (typeof embeddedContent === 'string' && embeddedContent.trim()) {
        const chunks = embeddedContent
            .split(/\n{2,}/)
            .map(part => part.trim())
            .filter(part => part.length >= 18);

        for (const chunk of chunks) {
            chunkSet.add(chunk);

            // Long retrieved chunks span more than one method or heading; extract distinctive lines
            // so containment still matches when the candidate declaration is smaller than the chunk.
            for (const line of chunk.split('\n')) {
                const trimmedLine = line.trim();

                if (trimmedLine.length >= 18 && !trimmedLine.startsWith('import ')) {
                    chunkSet.add(trimmedLine);
                }
            }
        }
    }

    return {
        exactTokens  : [...exactSet],
        subWords     : [...subWordSet],
        chunkSnippets: [...chunkSet].sort((left, right) => right.length - left.length).slice(0, 50)
    };
}

/**
 * @summary Scores a candidate text region against query tokens and retrieved chunk snippets.
 * @param {String} text
 * @param {{exactTokens: String[], subWords: String[], chunkSnippets: String[]}} signals
 * @param {{headerLines?: Number}} [options]
 * @returns {Number}
 * @private
 */
function scoreTextAgainstSignals(text, signals, {headerLines = 1} = {}) {
    const trimmed = String(text || '').trim();

    if (!trimmed) {
        return -1;
    }

    const
        lines     = trimmed.split('\n'),
        headLower = lines.slice(0, headerLines).join('\n').toLowerCase(),
        lower     = trimmed.toLowerCase();

    let score     = 0,
        chunkHits = 0;

    for (const snippet of signals.chunkSnippets) {
        if ((trimmed.length >= 18 && snippet.includes(trimmed)) || trimmed.includes(snippet)) {
            score += snippet.length >= 48 ? 500 : 350;
            chunkHits++;

            if (chunkHits >= 3) {
                break;
            }
        }
    }

    for (const token of signals.exactTokens) {
        if (headLower.includes(token)) {
            score += 60;
        }
        if (lower.includes(token)) {
            score += 25;
        }
    }

    for (const word of signals.subWords) {
        const stem = word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word;

        if (headLower.includes(stem)) {
            score += 30;
        }
        if (lower.includes(stem)) {
            score += 10;
        }
    }

    return score;
}

/**
 * @summary Builds a single-pass newline offset index for O(log L) offset-to-line lookup.
 * @param {String} content
 * @returns {{totalLines: Number, lineNumberAt: Function}}
 * @private
 */
function buildLineOffsetIndex(content) {
    const lineStarts = [0];

    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) {
            lineStarts.push(i + 1);
        }
    }

    const totalLines = lineStarts.length;

    return {
        totalLines,
        lineNumberAt(offset) {
            const clamped = Math.max(0, Math.min(offset, content.length));
            let   low     = 0,
                high = totalLines - 1;

            while (low <= high) {
                const mid = (low + high) >> 1;

                if (lineStarts[mid] <= clamped) {
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }

            return high + 1;
        }
    };
}

/**
 * @summary Formats an omission marker that distinguishes filesystem line ranges from embedded chunk coordinates.
 * @param {Number} startLine
 * @param {Number} endLine
 * @param {String} commentPrefix
 * @param {String} coordinateOrigin
 * @returns {String}
 * @private
 */
function omissionMarker(startLine, endLine, commentPrefix = '// ', coordinateOrigin = 'file') {
    if (coordinateOrigin === 'embedded') {
        return `${commentPrefix}... [embedded chunk content omitted] ...`;
    }

    return `${commentPrefix}... [lines ${startLine}-${endLine} omitted] ...`;
}

/**
 * @summary Formats an intra-line omission marker respecting filesystem vs embedded chunk coordinate custody.
 * @param {Object} options
 * @param {String} [options.commentPrefix='']
 * @param {Number} [options.lineNumber=1]
 * @param {Number} [options.startChar]
 * @param {Number} [options.endChar]
 * @param {String} [options.coordinateOrigin='file']
 * @returns {String}
 * @private
 */
function inlineOmissionMarker({commentPrefix = '', lineNumber = 1, startChar, endChar, coordinateOrigin = 'file'}) {
    if (coordinateOrigin === 'embedded') {
        return `${commentPrefix}... [embedded chunk content omitted] ...`;
    }

    if (Number.isFinite(startChar) && Number.isFinite(endChar)) {
        return `${commentPrefix}... [line ${lineNumber} characters ${startChar + 1}-${endChar} omitted] ...`;
    }

    return `${commentPrefix}... [characters omitted on line ${lineNumber}] ...`;
}

/**
 * @summary Locates the strongest match span inside one oversized line and slices a bounded window around it.
 * @param {String} lineText
 * @param {Object} options
 * @param {{exactTokens: String[], subWords: String[], chunkSnippets: String[]}} options.signals
 * @param {Number} options.maxChars
 * @param {Number} [options.lineNumber=1]
 * @param {String} [options.commentPrefix='']
 * @param {String} [options.coordinateOrigin='file']
 * @returns {String}
 * @private
 */
function windowSingleLongLine(lineText, {signals, maxChars, lineNumber = 1, commentPrefix = '', coordinateOrigin = 'file'}) {
    if (!(maxChars > 0) || lineText.length <= maxChars) {
        return lineText;
    }

    const lower  = lineText.toLowerCase();
    let   hitPos = -1,
          matchLen  = 0;

    for (const snippet of signals.chunkSnippets) {
        const snippetLower = snippet.toLowerCase();
        const foundAt      = lower.indexOf(snippetLower);

        if (foundAt >= 0) {
            hitPos   = foundAt;
            matchLen = snippetLower.length;
            break;
        }
    }

    if (hitPos < 0) {
        const
            windowSize = Math.min(360, Math.max(120, Math.floor(maxChars * 0.15))),
            step       = Math.max(60, Math.floor(windowSize / 3));
        let bestScore = -1,
            bestStart = 0;

        for (let pos = 0; pos < lower.length; pos += step) {
            const slice = lower.slice(pos, pos + windowSize);
            let   score = 0;

            for (const token of signals.exactTokens) {
                if (slice.includes(token)) {
                    score += 60;
                }
            }

            for (const word of signals.subWords) {
                const stem = word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word;

                if (slice.includes(stem)) {
                    score += 15;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestStart = pos;
            }
        }

        if (bestScore > 0) {
            const targetSlice = lower.slice(bestStart, bestStart + windowSize);
            const candidates  = [
                ...[...signals.exactTokens].sort((a, b) => b.length - a.length),
                ...[...signals.subWords].sort((a, b) => b.length - a.length)
            ];

            for (const candidate of candidates) {
                const offset = targetSlice.indexOf(candidate);

                if (offset >= 0) {
                    hitPos   = bestStart + offset;
                    matchLen = candidate.length;
                    break;
                }
            }

            if (hitPos < 0) {
                hitPos = bestStart;
            }
        }
    }

    if (hitPos < 0 || hitPos + Math.max(40, matchLen) <= maxChars) {
        const suffixReserve = 64;

        if (lineText.length > maxChars && maxChars > suffixReserve + 32) {
            const bodyLen   = maxChars - suffixReserve;
            const endMarker = inlineOmissionMarker({
                commentPrefix,
                lineNumber,
                startChar: bodyLen,
                endChar  : lineText.length,
                coordinateOrigin
            });
            const joined = `${lineText.slice(0, Math.max(1, maxChars - endMarker.length - 1))}\n${endMarker}`;

            return joined.length <= maxChars ? joined : joined.slice(0, maxChars);
        }

        return lineText.slice(0, maxChars);
    }

    const
        anchorEnd  = Math.min(lineText.length, hitPos + Math.max(matchLen, 160)),
        markerJoin = '\n',
        maxSlice   = Math.max(64, maxChars - 140);
    let sliceEnd   = Math.min(lineText.length, Math.max(anchorEnd + Math.floor(maxSlice * 0.2), maxSlice)),
        sliceStart = Math.max(0, sliceEnd - maxSlice);

    if (sliceStart > hitPos) {
        sliceStart = Math.max(0, hitPos - Math.floor(maxSlice * 0.35));
        sliceEnd   = Math.min(lineText.length, sliceStart + maxSlice);
    }

    const buildSlice = (start, end) => {
        const leadMarker = start > 0
            ? `${inlineOmissionMarker({commentPrefix, lineNumber, startChar: 0, endChar: start, coordinateOrigin})}${markerJoin}`
            : '';
        const tailMarker = end < lineText.length
            ? `${markerJoin}${inlineOmissionMarker({commentPrefix, lineNumber, startChar: end, endChar: lineText.length, coordinateOrigin})}`
            : '';

        return `${leadMarker}${lineText.slice(start, end)}${tailMarker}`;
    };

    let result = buildSlice(sliceStart, sliceEnd);

    // Trim upstream of the hit first so the matched tail evidence itself is never dropped by hard truncation.
    if (result.length > maxChars && sliceStart < hitPos) {
        const overflow = result.length - maxChars;
        sliceStart = Math.min(hitPos, sliceStart + overflow + 8);
        result     = buildSlice(sliceStart, sliceEnd);
    }

    if (result.length > maxChars) {
        result = result.slice(0, maxChars);
    }

    return result;
}

/**
 * @summary Windows an oversized contiguous text block around its highest-scoring inner lines.
 * @param {String} text
 * @param {Object} options
 * @param {{exactTokens: String[], subWords: String[], chunkSnippets: String[]}} options.signals
 * @param {Number} options.maxChars
 * @param {Number} [options.baseLine=1]
 * @param {String} [options.commentPrefix='// ']
 * @param {String} [options.coordinateOrigin='file']
 * @returns {String}
 * @private
 */
function windowTextBySignals(text, {signals, maxChars, baseLine = 1, commentPrefix = '// ', coordinateOrigin = 'file'}) {
    if (!(maxChars > 0) || text.length <= maxChars) {
        return text;
    }

    const lines = text.split('\n');

    if (lines.length === 1) {
        return windowSingleLongLine(text, {
            signals,
            maxChars,
            lineNumber: baseLine,
            commentPrefix,
            coordinateOrigin
        });
    }

    if (lines.length === 2) {
        const
            line0      = lines[0],
            line1      = lines[1],
            headBudget = Math.floor(maxChars * 0.25);

        if (line0.length <= headBudget && line1.length > maxChars - line0.length - 1) {
            const remaining = maxChars - line0.length - 1;
            const tailWin   = windowSingleLongLine(line1, {
                signals,
                maxChars  : remaining,
                lineNumber: baseLine + 1,
                commentPrefix,
                coordinateOrigin
            });

            return `${line0}\n${tailWin}`;
        }

        return windowSingleLongLine(text, {
            signals,
            maxChars,
            lineNumber: baseLine,
            commentPrefix,
            coordinateOrigin
        });
    }

    const
        headLimit = Math.min(Math.floor(maxChars * 0.2), 1200),
        headLines = [];
    let headChars = 0;

    for (let i = 0; i < lines.length && i < 12; i++) {
        const nextLen = headChars + lines[i].length + (headLines.length > 0 ? 1 : 0);

        if (headLines.length > 0 && nextLen > headLimit) {
            break;
        }
        if (nextLen > maxChars) {
            break;
        }

        headLines.push(lines[i]);
        headChars = nextLen;
    }

    const headCount = headLines.length;

    // Head lines are already retained unconditionally; score interior lines first so a method
    // signature or heading cannot outscore the retrieved body line hidden further down.
    let bestIndex = -1,
        bestScore = -1;

    for (let i = headCount; i < lines.length; i++) {
        const lineScore = scoreTextAgainstSignals(lines[i], signals, {headerLines: 1});

        if (lineScore > bestScore) {
            bestScore = lineScore;
            bestIndex = i;
        }
    }

    if (bestScore <= 0) {
        for (let i = 0; i < headCount; i++) {
            const lineScore = scoreTextAgainstSignals(lines[i], signals, {headerLines: 1});

            if (lineScore > bestScore) {
                bestScore = lineScore;
                bestIndex = i;
            }
        }
    }

    if (bestScore <= 0 || bestIndex < headCount) {
        const kept = [];
        let   len  = 0;

        for (let i = 0; i < lines.length; i++) {
            const trailer = i < lines.length - 1
                ? `\n${omissionMarker(baseLine + i + 1, baseLine + lines.length - 1, commentPrefix, coordinateOrigin)}`
                : '';
            const nextLen = len + lines[i].length + (kept.length > 0 ? 1 : 0);

            if (nextLen + trailer.length > maxChars) {
                break;
            }

            kept.push(lines[i]);
            len = nextLen;
        }

        if (kept.length === 0) {
            return windowSingleLongLine(lines[0], {
                signals,
                maxChars,
                lineNumber: baseLine,
                commentPrefix,
                coordinateOrigin
            });
        }

        const omittedAfter = kept.length < lines.length
            ? `\n${omissionMarker(baseLine + kept.length, baseLine + lines.length - 1, commentPrefix, coordinateOrigin)}`
            : '';

        return `${kept.join('\n')}${omittedAfter}`.slice(0, maxChars);
    }

    let start = bestIndex,
        end   = bestIndex;

    const renderRange = (winStart, winEnd) => {
        const parts = [];

        if (headCount > 0) {
            parts.push(headLines.join('\n'));
        }

        const gapBeforeStart = headCount;
        const gapBeforeEnd   = winStart - 1;

        if (gapBeforeEnd >= gapBeforeStart) {
            parts.push(omissionMarker(baseLine + gapBeforeStart, baseLine + gapBeforeEnd, commentPrefix, coordinateOrigin));
        }

        const bodyStart = Math.max(headCount, winStart);

        if (winEnd >= bodyStart) {
            parts.push(lines.slice(bodyStart, winEnd + 1).join('\n'));
        }

        if (winEnd < lines.length - 1) {
            parts.push(omissionMarker(baseLine + winEnd + 1, baseLine + lines.length - 1, commentPrefix, coordinateOrigin));
        }

        return parts.join('\n');
    };

    if (renderRange(start, end).length > maxChars) {
        const
            parts      = [],
            keepHeader = headCount > 0 && headChars <= Math.floor(maxChars * 0.2),
            preMarker  = bestIndex > (keepHeader ? headCount : 0)
                ? omissionMarker(baseLine + (keepHeader ? headCount : 0), baseLine + bestIndex - 1, commentPrefix, coordinateOrigin)
                : '',
            postMarker     = bestIndex < lines.length - 1
                ? omissionMarker(baseLine + bestIndex + 1, baseLine + lines.length - 1, commentPrefix, coordinateOrigin)
                : '',
            headerOverhead = (keepHeader ? headChars + 1 : 0)
                + (preMarker ? preMarker.length + 1 : 0)
                + (postMarker ? postMarker.length + 1 : 0),
            lineBudget     = Math.max(128, maxChars - headerOverhead),
            windowedLine   = windowSingleLongLine(lines[bestIndex], {
                signals,
                maxChars  : lineBudget,
                lineNumber: baseLine + bestIndex,
                commentPrefix,
                coordinateOrigin
            });

        if (keepHeader) {
            parts.push(headLines.join('\n'));
        }
        if (preMarker) {
            parts.push(preMarker);
        }
        parts.push(windowedLine);
        if (postMarker) {
            parts.push(postMarker);
        }

        const combined = parts.join('\n');

        return combined.length <= maxChars ? combined : combined.slice(0, maxChars);
    }

    let step = 0;

    while (start > headCount || end < lines.length - 1) {
        // Expand 2:1 downward vs upward around the match so implementations following headings fit first.
        const preferDown = step % 3 !== 2;
        let   nextStart  = start,
              nextEnd    = end;

        if (preferDown && end < lines.length - 1) {
            nextEnd++;
        } else if (!preferDown && start > headCount) {
            nextStart--;
        } else if (end < lines.length - 1) {
            nextEnd++;
        } else if (start > headCount) {
            nextStart--;
        }

        step++;

        if (renderRange(nextStart, nextEnd).length > maxChars) {
            break;
        }

        start = nextStart;
        end   = nextEnd;
    }

    return renderRange(start, end);
}

/**
 * @summary Unwraps class declarations (including `export default` / `export`) when present.
 * @param {Object} stmt
 * @returns {Object|null}
 * @private
 */
function findClassDeclaration(stmt) {
    if (!stmt) {
        return null;
    }

    if (stmt.type === 'ClassDeclaration') {
        return stmt;
    }

    if (
        (stmt.type === 'ExportDefaultDeclaration' || stmt.type === 'ExportNamedDeclaration')
        && stmt.declaration?.type === 'ClassDeclaration'
    ) {
        return stmt.declaration;
    }

    return null;
}

/**
 * @summary Parses a JS module into a bounded preamble plus member/declaration source units.
 * @param {String} content
 * @param {{totalLines: Number, lineNumberAt: Function}} [lineIndex]
 * @returns {{preamble: String, preambleEndLine: Number, units: Array, totalLines: Number}|null}
 * @private
 */
function extractJavaScriptUnits(content, lineIndex = buildLineOffsetIndex(content)) {
    let ast;

    for (const sourceType of ['module', 'script']) {
        try {
            ast = acorn.parse(content, {
                ecmaVersion  : 'latest',
                sourceType,
                locations    : true,
                allowHashBang: true
            });
            break;
        } catch {
            ast = null;
        }
    }

    if (!ast || !Array.isArray(ast.body) || ast.body.length === 0) {
        return null;
    }

    const {totalLines, lineNumberAt} = lineIndex;

    let importEndOffset = 0,
        bodyStartIndex  = 0;

    while (bodyStartIndex < ast.body.length && ast.body[bodyStartIndex].type === 'ImportDeclaration') {
        importEndOffset = ast.body[bodyStartIndex].end;
        bodyStartIndex++;
    }

    let   preambleEndOffset = importEndOffset;
    let   cursor            = importEndOffset;
    const units             = [];

    for (let i = bodyStartIndex; i < ast.body.length; i++) {
        const
            stmt      = ast.body[i],
            classNode = findClassDeclaration(stmt);

        if (classNode && Array.isArray(classNode.body?.body) && classNode.body.body.length > 0) {
            const classBodyOpenEnd = classNode.body.start + 1;

            if (units.length === 0 && classBodyOpenEnd <= 2400) {
                preambleEndOffset = classBodyOpenEnd;
            } else {
                const headerStart = cursor;

                units.push({
                    start    : headerStart,
                    end      : classBodyOpenEnd,
                    startLine: lineNumberAt(headerStart),
                    endLine  : lineNumberAt(classBodyOpenEnd),
                    text     : content.slice(headerStart, classBodyOpenEnd).replace(/^\n+/, ''),
                    pinned   : true
                });
            }

            let memberCursor = classBodyOpenEnd;

            for (const member of classNode.body.body) {
                while (memberCursor < member.start && content[memberCursor] === '\n') {
                    memberCursor++;
                }

                const unitText = content.slice(memberCursor, member.end);

                if (unitText.trim()) {
                    units.push({
                        start    : memberCursor,
                        end      : member.end,
                        startLine: lineNumberAt(memberCursor),
                        endLine  : lineNumberAt(member.end),
                        text     : unitText
                    });
                }

                memberCursor = member.end;
            }

            cursor = stmt.end;
            continue;
        }

        while (cursor < stmt.start && content[cursor] === '\n') {
            cursor++;
        }

        const unitText = content.slice(cursor, stmt.end);

        if (unitText.trim()) {
            units.push({
                start    : cursor,
                end      : stmt.end,
                startLine: lineNumberAt(cursor),
                endLine  : lineNumberAt(stmt.end),
                text     : unitText
            });
        }

        cursor = stmt.end;
    }

    if (units.length === 0) {
        return null;
    }

    const rawPreamble = content.slice(0, preambleEndOffset).trimEnd();

    return {
        preamble       : rawPreamble,
        preambleEndLine: rawPreamble ? lineNumberAt(preambleEndOffset) : 0,
        units,
        totalLines
    };
}

/**
 * @summary Builds a bounded code window from AST preamble, reserving strongest-evidence units first.
 * @param {String} content
 * @param {{exactTokens: String[], subWords: String[], chunkSnippets: String[]}} signals
 * @param {Number} maxCharsPerDocument
 * @param {Object} [options]
 * @param {String} [options.coordinateOrigin='file']
 * @param {{totalLines: Number, lineNumberAt: Function}} [options.lineIndex]
 * @returns {{content: String, shortened: Boolean}|null}
 * @private
 */
function windowJavaScriptModule(content, signals, maxCharsPerDocument, {coordinateOrigin = 'file', lineIndex} = {}) {
    const parsed = extractJavaScriptUnits(content, lineIndex);

    if (!parsed) {
        return null;
    }

    const
        {preamble, preambleEndLine, units, totalLines} = parsed,
        scored                                         = units.map((unit, index) => ({
            ...unit,
            index,
            score: scoreTextAgainstSignals(unit.text, signals, {headerLines: 6})
        }));

    if (!scored.some(item => item.score > 0)) {
        return null;
    }

    const
        maxPreamble       = Math.floor(maxCharsPerDocument * 0.25),
        headerBlock       = preamble.length <= maxPreamble ? preamble : preamble.slice(0, maxPreamble).replace(/\n[^\n]*$/, ''),
        headerEndLine     = headerBlock === preamble ? preambleEndLine : headerBlock.split('\n').length,
        selectedSet       = new Set(),
        unitTextOverrides = new Map();

    scored.forEach((item, index) => {
        if (item.pinned) {
            selectedSet.add(index);
        }
    });

    const render = indicesSet => {
        const sorted = [...indicesSet]
            .sort((left, right) => left - right)
            .map(idx => scored[idx]);

        const parts       = [];
        let   lastEndLine = 0;

        if (headerBlock) {
            parts.push(headerBlock);
            lastEndLine = headerEndLine;
        }

        for (const item of sorted) {
            if (item.startLine > lastEndLine + 1) {
                parts.push(omissionMarker(lastEndLine + 1, item.startLine - 1, '// ', coordinateOrigin));
            }

            parts.push(unitTextOverrides.get(item.index) ?? item.text);
            lastEndLine = item.endLine;
        }

        if (lastEndLine < totalLines) {
            parts.push(omissionMarker(lastEndLine + 1, totalLines, '// ', coordinateOrigin));
        }

        return parts.join('\n');
    };

    if (render(selectedSet).length > maxCharsPerDocument) {
        selectedSet.clear();
    }

    const ranked = [...scored]
        .filter(item => !item.pinned && item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);

    // Reserve the strongest retrieved match first (windowing inside it if oversized) so weaker
    // fitting methods never exhaust the cap before the primary evidence is admitted.
    if (ranked.length > 0) {
        const
            topCandidate = ranked[0],
            firstSet     = new Set(selectedSet);

        firstSet.add(topCandidate.index);

        if (render(firstSet).length <= maxCharsPerDocument) {
            selectedSet.add(topCandidate.index);
        } else {
            const
                baseOverhead  = render(selectedSet).length,
                markerReserve = 160,
                available     = Math.max(512, maxCharsPerDocument - baseOverhead - markerReserve),
                topBudget     = ranked.length > 1
                    ? Math.max(512, Math.floor(available * 0.85))
                    : available;

            let windowedTop = windowTextBySignals(topCandidate.text, {
                signals,
                maxChars     : topBudget,
                baseLine     : topCandidate.startLine,
                commentPrefix: '// ',
                coordinateOrigin
            });

            unitTextOverrides.set(topCandidate.index, windowedTop);
            selectedSet.add(topCandidate.index);

            if (render(selectedSet).length > maxCharsPerDocument) {
                scored.forEach((item, index) => {
                    if (item.pinned) {
                        selectedSet.delete(index);
                    }
                });

                const unpinnedOverhead = render(new Set()).length + markerReserve;
                const retryBudget      = Math.max(256, maxCharsPerDocument - unpinnedOverhead);

                if (windowedTop.length > retryBudget) {
                    windowedTop = windowTextBySignals(topCandidate.text, {
                        signals,
                        maxChars     : retryBudget,
                        baseLine     : topCandidate.startLine,
                        commentPrefix: '// ',
                        coordinateOrigin
                    });
                    unitTextOverrides.set(topCandidate.index, windowedTop);
                }
            }
        }
    }

    let currentLength = render(selectedSet).length;

    for (const candidate of ranked.slice(1)) {
        if (currentLength + candidate.text.length - 64 > maxCharsPerDocument) {
            continue;
        }

        const nextSet = new Set(selectedSet);
        nextSet.add(candidate.index);
        const nextLength = render(nextSet).length;

        if (nextLength <= maxCharsPerDocument) {
            selectedSet.add(candidate.index);
            currentLength = nextLength;
        }
    }

    // Pull immediate adjacent sibling units when spare budget remains so nearby helpers travel together.
    if (ranked.length > 0) {
        const topIndex = ranked[0].index;

        for (const offset of [-1, 1, -2, 2]) {
            const neighbor = topIndex + offset;

            if (neighbor < 0 || neighbor >= scored.length || selectedSet.has(neighbor)) {
                continue;
            }

            if (currentLength + scored[neighbor].text.length - 64 > maxCharsPerDocument) {
                continue;
            }

            const nextSet = new Set(selectedSet);
            nextSet.add(neighbor);
            const nextLength = render(nextSet).length;

            if (nextLength <= maxCharsPerDocument) {
                selectedSet.add(neighbor);
                currentLength = nextLength;
            }
        }
    }

    const rendered = render(selectedSet);

    if (!rendered || rendered.length > maxCharsPerDocument) {
        return null;
    }

    return {
        content  : rendered,
        shortened: unitTextOverrides.size > 0 || selectedSet.size < scored.length || rendered.length < content.length
    };
}

/**
 * @summary Splits Markdown content into heading sections without splitting inside fenced code blocks.
 * @param {String} content Raw Markdown content.
 * @returns {String[]} Ordered Markdown sections whose concatenation equals `content`.
 */
export function splitMarkdownSections(content) {
    if (typeof content !== 'string' || !content) {
        return [];
    }

    const
        lines    = content.match(/[^\n]*\n|[^\n]+/g) || [],
        sections = [];
    let current    = '',
        fenceChar  = '',
        fenceCount = 0;

    for (const line of lines) {
        const
            stripped   = line.replace(/\r?\n$/, ''),
            fenceMatch = stripped.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);

        if (fenceChar) {
            current += line;

            if (
                fenceMatch
                && fenceMatch[1][0] === fenceChar
                && fenceMatch[1].length >= fenceCount
                && fenceMatch[2].trim() === ''
            ) {
                fenceChar  = '';
                fenceCount = 0;
            }
            continue;
        }

        if (fenceMatch) {
            const
                marker = fenceMatch[1],
                rest   = fenceMatch[2] || '';

            if (marker[0] !== '\x60' || !rest.includes('\x60')) {
                fenceChar  = marker[0];
                fenceCount = marker.length;
            }

            current += line;
            continue;
        }

        if (/^ {0,3}#{1,6}\s/.test(stripped) && current) {
            sections.push(current);
            current = line;
            continue;
        }

        current += line;
    }

    if (current) {
        sections.push(current);
    }

    return sections;
}

/**
 * @summary Reorders multi-section Markdown or windows oversized single-section source/prose documents
 * around matched chunks and query signals before ask-context budget assembly.
 * @param {String} content
 * @param {Object} [options]
 * @param {String} [options.query='']
 * @param {String} [options.embeddedContent='']
 * @param {String} [options.source='']
 * @param {Number} [options.maxCharsPerDocument=0]
 * @param {String} [options.coordinateOrigin='file']
 * @returns {{content: String, shortened: Boolean}}
 */
export function prioritizeOversizedDocument(content, {
    query               = '',
    embeddedContent     = '',
    source              = '',
    maxCharsPerDocument = 0,
    coordinateOrigin    = 'file'
} = {}) {
    if (typeof content !== 'string' || !(maxCharsPerDocument > 0) || content.length <= maxCharsPerDocument) {
        return {content, shortened: false};
    }

    const signals = extractQuerySignals(query, embeddedContent);

    if (
        signals.exactTokens.length === 0
        && signals.subWords.length === 0
        && signals.chunkSnippets.length === 0
    ) {
        return {content, shortened: false};
    }

    const
        isExplicitCode = CODE_EXTENSION_RE.test(source),
        isExplicitDoc  = DOC_EXTENSION_RE.test(source),
        lineIndex      = buildLineOffsetIndex(content);

    if (isExplicitCode) {
        const windowed = windowJavaScriptModule(content, signals, maxCharsPerDocument, {
            coordinateOrigin,
            lineIndex
        });

        if (windowed) {
            return windowed;
        }

        const fallback = windowTextBySignals(content, {
            signals,
            maxChars     : maxCharsPerDocument,
            baseLine     : 1,
            commentPrefix: '// ',
            coordinateOrigin
        });

        return {
            content  : fallback,
            shortened: fallback.length < content.length
        };
    }

    const sections = splitMarkdownSections(content);

    if (sections.length > 1) {
        const scored = sections.map((section, index) => ({
            index,
            section,
            score: scoreTextAgainstSignals(section, signals, {headerLines: 1})
        }));

        if (!scored.some(item => item.score > 0)) {
            return {content, shortened: false};
        }

        scored.sort((left, right) => right.score - left.score || left.index - right.index);

        if (scored[0].section.length <= maxCharsPerDocument) {
            return {
                content  : scored.map(item => item.section).join(''),
                shortened: false
            };
        }

        // Only when the winning section itself exceeds maxCharsPerDocument does reordering alone still
        // clip matches near its tail; window the winning section first so askContextBudget preserves them.
        const windowedTop = windowTextBySignals(scored[0].section, {
            signals,
            maxChars     : maxCharsPerDocument,
            baseLine     : lineIndex.lineNumberAt(content.indexOf(scored[0].section)),
            commentPrefix: '',
            coordinateOrigin
        });

        return {
            content  : windowedTop,
            shortened: windowedTop.length < content.length
        };
    }

    if (!isExplicitDoc) {
        const windowedCode = windowJavaScriptModule(content, signals, maxCharsPerDocument, {
            coordinateOrigin,
            lineIndex
        });

        if (windowedCode) {
            return windowedCode;
        }
    }

    const windowedText = windowTextBySignals(content, {
        signals,
        maxChars     : maxCharsPerDocument,
        baseLine     : 1,
        commentPrefix: '',
        coordinateOrigin
    });

    return {
        content  : windowedText,
        shortened: windowedText.length < content.length
    };
}
