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
            .filter(part => part.length >= 24);

        for (const chunk of chunks) {
            chunkSet.add(chunk);

            // Long retrieved chunks span more than one method or heading; extract distinctive lines
            // so containment still matches when the candidate declaration is smaller than the chunk.
            for (const line of chunk.split('\n')) {
                const trimmedLine = line.trim();

                if (trimmedLine.length >= 28 && !trimmedLine.startsWith('import ')) {
                    chunkSet.add(trimmedLine);
                }
            }
        }
    }

    return {
        exactTokens  : [...exactSet],
        subWords     : [...subWordSet],
        chunkSnippets: [...chunkSet].slice(0, 40)
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
        if ((trimmed.length >= 32 && snippet.includes(trimmed)) || trimmed.includes(snippet)) {
            score += snippet.length >= 48 ? 35 : 20;
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
 * @summary Counts 1-based line number of a character offset inside source text.
 * @param {String} content
 * @param {Number} offset
 * @returns {Number}
 * @private
 */
function lineNumberAt(content, offset) {
    let lines = 1;

    for (let i = 0; i < offset && i < content.length; i++) {
        if (content.charCodeAt(i) === 10) {
            lines++;
        }
    }

    return lines;
}

/**
 * @summary Formats an explicit line-range omission marker matching the document syntax.
 * @param {Number} startLine
 * @param {Number} endLine
 * @param {String} commentPrefix
 * @returns {String}
 * @private
 */
function omissionMarker(startLine, endLine, commentPrefix = '// ') {
    return `${commentPrefix}... [lines ${startLine}-${endLine} omitted] ...`;
}

/**
 * @summary Windows an oversized contiguous text block around its highest-scoring inner lines.
 * @param {String} text
 * @param {Object} options
 * @param {{exactTokens: String[], subWords: String[], chunkSnippets: String[]}} options.signals
 * @param {Number} options.maxChars
 * @param {Number} [options.baseLine=1]
 * @param {String} [options.commentPrefix='// ']
 * @returns {String}
 * @private
 */
function windowTextBySignals(text, {signals, maxChars, baseLine = 1, commentPrefix = '// '}) {
    if (!(maxChars > 0) || text.length <= maxChars) {
        return text;
    }

    const lines = text.split('\n');

    if (lines.length <= 2) {
        const lower   = text.toLowerCase(),
              targets = [...signals.exactTokens, ...signals.subWords];
        let hitPos = -1;

        for (const target of targets) {
            const pos = lower.indexOf(target);

            if (pos >= 0 && (hitPos < 0 || pos < hitPos)) {
                hitPos = pos;
            }
        }

        if (hitPos < 0 || hitPos + 40 <= maxChars) {
            return text.slice(0, maxChars);
        }

        const
            prefix     = `${commentPrefix}... `,
            available  = Math.max(1, maxChars - prefix.length),
            sliceStart = Math.max(0, Math.min(text.length - available, hitPos - Math.floor(available * 0.25)));

        return `${prefix}${text.slice(sliceStart, sliceStart + available)}`.slice(0, maxChars);
    }

    let bestIndex = 0,
        bestScore = -1;

    for (let i = 0; i < lines.length; i++) {
        const lineScore = scoreTextAgainstSignals(lines[i], signals, {headerLines: 1});

        if (lineScore > bestScore) {
            bestScore = lineScore;
            bestIndex = i;
        }
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

    if (bestScore <= 0 || bestIndex < headCount) {
        const kept = [];
        let   len  = 0;

        for (let i = 0; i < lines.length; i++) {
            const trailer = i < lines.length - 1 ? `\n${omissionMarker(baseLine + i + 1, baseLine + lines.length - 1, commentPrefix)}` : '';
            const nextLen = len + lines[i].length + (kept.length > 0 ? 1 : 0);

            if (nextLen + trailer.length > maxChars) {
                break;
            }

            kept.push(lines[i]);
            len = nextLen;
        }

        if (kept.length === 0) {
            return text.slice(0, maxChars);
        }

        const omittedAfter = kept.length < lines.length
            ? `\n${omissionMarker(baseLine + kept.length, baseLine + lines.length - 1, commentPrefix)}`
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
            parts.push(omissionMarker(baseLine + gapBeforeStart, baseLine + gapBeforeEnd, commentPrefix));
        }

        const bodyStart = Math.max(headCount, winStart);

        if (winEnd >= bodyStart) {
            parts.push(lines.slice(bodyStart, winEnd + 1).join('\n'));
        }

        if (winEnd < lines.length - 1) {
            parts.push(omissionMarker(baseLine + winEnd + 1, baseLine + lines.length - 1, commentPrefix));
        }

        return parts.join('\n');
    };

    if (renderRange(start, end).length > maxChars) {
        return lines[bestIndex].slice(0, maxChars);
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
 * @returns {{preamble: String, preambleEndLine: Number, units: Array, totalLines: Number}|null}
 * @private
 */
function extractJavaScriptUnits(content) {
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

    const totalLines = content.split('\n').length;

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
                    startLine: lineNumberAt(content, headerStart),
                    endLine  : lineNumberAt(content, classBodyOpenEnd),
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
                        startLine: lineNumberAt(content, memberCursor),
                        endLine  : lineNumberAt(content, member.end),
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
                startLine: lineNumberAt(content, cursor),
                endLine  : lineNumberAt(content, stmt.end),
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
        preambleEndLine: rawPreamble ? lineNumberAt(content, preambleEndOffset) : 0,
        units,
        totalLines
    };
}

/**
 * @summary Builds a bounded code window from AST preamble, highest-scored units, and line-gap markers.
 * @param {String} content
 * @param {{exactTokens: String[], subWords: String[], chunkSnippets: String[]}} signals
 * @param {Number} maxCharsPerDocument
 * @returns {{content: String, shortened: Boolean}|null}
 * @private
 */
function windowJavaScriptModule(content, signals, maxCharsPerDocument) {
    const parsed = extractJavaScriptUnits(content);

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
        maxPreamble   = Math.floor(maxCharsPerDocument * 0.25),
        headerBlock   = preamble.length <= maxPreamble ? preamble : preamble.slice(0, maxPreamble).replace(/\n[^\n]*$/, ''),
        headerEndLine = headerBlock === preamble ? preambleEndLine : headerBlock.split('\n').length,
        selectedSet   = new Set();

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
                parts.push(omissionMarker(lastEndLine + 1, item.startLine - 1, '// '));
            }

            parts.push(item.text);
            lastEndLine = item.endLine;
        }

        if (lastEndLine < totalLines) {
            parts.push(omissionMarker(lastEndLine + 1, totalLines, '// '));
        }

        return parts.join('\n');
    };

    if (render(selectedSet).length > maxCharsPerDocument) {
        selectedSet.clear();
    }

    const ranked = [...scored]
        .filter(item => !item.pinned && item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);

    for (const candidate of ranked) {
        const nextSet = new Set(selectedSet);
        nextSet.add(candidate.index);

        if (render(nextSet).length <= maxCharsPerDocument) {
            selectedSet.add(candidate.index);
        }
    }

    // If the top match itself exceeds the whole document cap, window inside that declaration
    // so callers still inspect its signature and matched implementation lines.
    const hasPositiveHit = [...selectedSet].some(idx => scored[idx].score > 0);

    if (!hasPositiveHit && ranked.length > 0) {
        const
            topItem      = ranked[0],
            overheadText = render(selectedSet),
            reserve      = overheadText ? overheadText.length + 120 : 120,
            methodBudget = Math.max(256, maxCharsPerDocument - reserve),
            windowedText = windowTextBySignals(topItem.text, {
                signals,
                maxChars     : methodBudget,
                baseLine     : topItem.startLine,
                commentPrefix: '// '
            });

        const parts = [];

        if (headerBlock) {
            parts.push(headerBlock);

            if (topItem.startLine > headerEndLine + 1) {
                parts.push(omissionMarker(headerEndLine + 1, topItem.startLine - 1, '// '));
            }
        } else if (topItem.startLine > 1) {
            parts.push(omissionMarker(1, topItem.startLine - 1, '// '));
        }

        parts.push(windowedText);

        if (topItem.endLine < totalLines) {
            parts.push(omissionMarker(topItem.endLine + 1, totalLines, '// '));
        }

        const fallbackRendered = parts.join('\n').slice(0, maxCharsPerDocument);

        return {
            content  : fallbackRendered,
            shortened: fallbackRendered.length < content.length
        };
    }

    // Pull immediate adjacent sibling units when spare budget remains so nearby helpers travel together.
    if (ranked.length > 0) {
        const topIndex = ranked[0].index;

        for (const offset of [-1, 1, -2, 2]) {
            const neighbor = topIndex + offset;

            if (neighbor < 0 || neighbor >= scored.length || selectedSet.has(neighbor)) {
                continue;
            }

            const nextSet = new Set(selectedSet);
            nextSet.add(neighbor);

            if (render(nextSet).length <= maxCharsPerDocument) {
                selectedSet.add(neighbor);
            }
        }
    }

    const rendered = render(selectedSet);

    if (!rendered || rendered.length > maxCharsPerDocument) {
        return null;
    }

    return {
        content  : rendered,
        shortened: selectedSet.size < scored.length || rendered.length < content.length
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
 * @returns {{content: String, shortened: Boolean}}
 */
export function prioritizeOversizedDocument(content, {
    query               = '',
    embeddedContent     = '',
    source              = '',
    maxCharsPerDocument = 0
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
        isExplicitDoc  = DOC_EXTENSION_RE.test(source);

    if (isExplicitCode) {
        const windowed = windowJavaScriptModule(content, signals, maxCharsPerDocument);

        if (windowed) {
            return windowed;
        }

        const fallback = windowTextBySignals(content, {
            signals,
            maxChars     : maxCharsPerDocument,
            baseLine     : 1,
            commentPrefix: '// '
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
            baseLine     : lineNumberAt(content, content.indexOf(scored[0].section)),
            commentPrefix: ''
        });

        return {
            content  : windowedTop,
            shortened: windowedTop.length < content.length
        };
    }

    if (!isExplicitDoc) {
        const windowedCode = windowJavaScriptModule(content, signals, maxCharsPerDocument);

        if (windowedCode) {
            return windowedCode;
        }
    }

    const windowedText = windowTextBySignals(content, {
        signals,
        maxChars     : maxCharsPerDocument,
        baseLine     : 1,
        commentPrefix: ''
    });

    return {
        content  : windowedText,
        shortened: windowedText.length < content.length
    };
}
