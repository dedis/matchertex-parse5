import { it, assert, describe } from 'vitest';
import {
    parse,
    parseFragment,
    serialize,
    verifyMatchertext,
    MatchertextError,
    ErrorCodes,
    Parser,
    type ParserError,
    type DefaultTreeAdapterMap,
    type DefaultTreeAdapterTypes,
} from 'parse5';
import { random, randomString } from 'parse5-test-utils/utils/common.js';

type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Template = DefaultTreeAdapterTypes.Template;

const MT = { matchertext: true };
// Writes every tree of matchertext input, to compare trees.
const TREE = { matchertextOutput: true };

/** The input normalization of HTML: CR and CRLF become LF, and NUL in matchertext becomes U+FFFD. */
function normalize(value: string): string {
    return value.replace(/\r\n?/g, '\n').replace(/\0/g, '�');
}

function element(node: ChildNode | undefined): Element {
    assert.ok(node && 'tagName' in node, 'an element');
    return node;
}

/** The text of `node`, which must have no child or one text child. */
function textOf(node: Element | Template): string {
    const parent = node.nodeName === 'template' ? (node as Template).content : node;
    assert.ok(parent.childNodes.length <= 1, 'at most one child');

    if (parent.childNodes.length === 0) {
        return '';
    }

    const [text] = parent.childNodes;
    assert.strictEqual(text.nodeName, '#text');
    return (text as TextNode).value;
}

function errorOf(parse: () => unknown): MatchertextError {
    try {
        parse();
    } catch (error) {
        assert.ok(error instanceof MatchertextError, String(error));
        return error;
    }

    throw new Error('Expected a MatchertextError');
}

// Matchers and markup that a hole must keep as data.
const CONTENT = String.raw`<b>&amp;</b></div></script></style></textarea></title><!-- "' [x] (y) {z} [[a]]>[]`;

describe('matchertext parsing', () => {
    describe('element content', () => {
        for (const tagName of [
            'div',
            'code',
            'pre',
            'listing',
            'textarea',
            'title',
            'script',
            'style',
            'xmp',
            'iframe',
            'noembed',
            'noframes',
            'noscript',
            'plaintext',
            'template',
            'option',
        ]) {
            it(`is the text of <${tagName}>`, () => {
                const fragment = parseFragment(`<${tagName} id=h [${CONTENT}]><i>after</i>`, MT);
                const [hole, after] = fragment.childNodes;

                assert.strictEqual(fragment.childNodes.length, 2);
                assert.strictEqual(element(hole).tagName, tagName);
                assert.deepEqual(element(hole).attrs, [{ name: 'id', value: 'h' }]);
                assert.strictEqual(textOf(element(hole)), CONTENT);
                assert.strictEqual(serialize(element(after)), 'after');
            });
        }

        it('is text in table cells, captions and foreign content', () => {
            for (const [html, path] of [
                [`<table><tr><td [${CONTENT}]>`, [0, 0, 0, 0]],
                [`<table><caption [${CONTENT}]>`, [0, 0]],
                [`<table><p [${CONTENT}]>`, [0]],
                [`<select><option [${CONTENT}]>`, [0, 0]],
                [`<svg><text [${CONTENT}]></svg>`, [0, 0]],
                [`<math><mi [${CONTENT}]></math>`, [0, 0]],
            ] as const) {
                let node = parseFragment(html, MT) as unknown as Element;
                for (const index of path) {
                    node = element(node.childNodes[index]);
                }
                assert.strictEqual(textOf(node), CONTENT, html);
            }
        });

        it('keeps a leading line feed', () => {
            for (const tagName of ['pre', 'textarea', 'listing']) {
                const [hole] = parseFragment(`<${tagName} [\nline]>`, MT).childNodes;
                assert.strictEqual(textOf(element(hole)), '\nline');
            }
        });

        it('normalizes line breaks and NUL as input', () => {
            const errors: ParserError[] = [];
            const [hole] = parseFragment('<div [a\r\nb\rc\0]>', {
                ...MT,
                onParseError: (error): void => {
                    errors.push(error);
                },
            }).childNodes;

            assert.strictEqual(textOf(element(hole)), 'a\nb\nc�');
            assert.deepEqual(
                errors.map(({ code }) => code),
                [ErrorCodes.unexpectedNullCharacter],
            );
        });

        it('may be empty', () => {
            const [hole] = parseFragment('<div []>', MT).childNodes;
            assert.strictEqual(element(hole).childNodes.length, 0);
        });

        it('nests to the depth limit', () => {
            const value = '('.repeat(1000) + ')'.repeat(1000);
            assert.strictEqual(textOf(element(parseFragment(`<div [${value}]>`, MT).childNodes[0])), value);
            assert.strictEqual(
                errorOf(() => parseFragment(`<div [(${value})]>`, MT)).code,
                ErrorCodes.matchertextDepthLimit,
            );
        });
    });

    describe('attribute value', () => {
        it('is the data between the brackets', () => {
            const value = String.raw`show("it's done!") &amp; <b> [x] {y} > /`;
            const [hole] = parseFragment(`<button onclick=[${value}] id=b>OK</button>`, MT).childNodes;

            assert.deepEqual(element(hole).attrs, [
                { name: 'onclick', value },
                { name: 'id', value: 'b' },
            ]);
        });

        it('normalizes line breaks and NUL as input', () => {
            const [hole] = parseFragment('<a title=[a\r\nb\0]>', MT).childNodes;
            assert.deepEqual(element(hole).attrs, [{ name: 'title', value: 'a\nb�' }]);
        });

        it('may be followed by element content', () => {
            const [hole] = parseFragment('<a title=[t] [c]>', MT).childNodes;

            assert.deepEqual(element(hole).attrs, [{ name: 'title', value: 't' }]);
            assert.strictEqual(textOf(element(hole)), 'c');
        });
    });

    describe('MDATA section', () => {
        it('is text in HTML and foreign content', () => {
            assert.strictEqual(
                textOf(element(parseFragment(`<p>a<![MDATA[${CONTENT}]]>b</p>`, MT).childNodes[0])),
                `a${CONTENT}b`,
            );
            assert.strictEqual(
                textOf(element(parseFragment(`<svg><![MDATA[${CONTENT}]]></svg>`, MT).childNodes[0])),
                CONTENT,
            );
        });

        it('normalizes NUL as input', () => {
            assert.strictEqual(textOf(element(parseFragment('<p><![MDATA[\0]]></p>', MT).childNodes[0])), '�');
        });
    });

    describe('errors', () => {
        for (const [html, code, col] of [
            ['<div [a', ErrorCodes.eofInMatchertext, 8],
            ['<div [a)]>', ErrorCodes.matchertextUnmatchedCloser, 8],
            ['<div [a]', ErrorCodes.matchertextMissingTerminator, 9],
            ['<div [a]x', ErrorCodes.matchertextMissingTerminator, 9],
            ['<a [b]="x">', ErrorCodes.matchertextMissingTerminator, 7],
            ['<a [>', ErrorCodes.eofInMatchertext, 6],
            ['<a a [>', ErrorCodes.eofInMatchertext, 8],
            ['</div [x]>', ErrorCodes.matchertextInEndTag, 7],
            ['<div x=[a', ErrorCodes.eofInMatchertext, 10],
            ['<div x=[a}]>', ErrorCodes.matchertextUnmatchedCloser, 10],
            ['<p><![MDATA[a', ErrorCodes.eofInMatchertext, 14],
            ['<p><![MDATA[a]x', ErrorCodes.matchertextMissingTerminator, 15],
            ['<p><![MDATA[a]]x', ErrorCodes.matchertextMissingTerminator, 16],
            ['<br [x]>', ErrorCodes.matchertextElementCannotHoldText, 5],
            ['<img [x]>', ErrorCodes.matchertextElementCannotHoldText, 6],
            ['<image [x]>', ErrorCodes.matchertextElementCannotHoldText, 8],
            ['<input [value]="x">', ErrorCodes.matchertextElementCannotHoldText, 8],
            ['<table [x]>', ErrorCodes.matchertextElementCannotHoldText, 8],
            ['<table><tbody [x]>', ErrorCodes.matchertextElementCannotHoldText, 15],
            ['<table><tr [x]>', ErrorCodes.matchertextElementCannotHoldText, 12],
            ['<table><colgroup [x]>', ErrorCodes.matchertextElementCannotHoldText, 18],
            ['<select><select [x]>', ErrorCodes.matchertextElementCannotHoldText, 17],
            ['<body [x]>', ErrorCodes.matchertextElementCannotHoldText, 7],
        ] as const) {
            it(`refuses \`${html}\` with ${code}`, () => {
                const error = errorOf(() => parseFragment(html, MT));

                assert.strictEqual(error.code, code);
                assert.strictEqual(error.location?.startLine, 1);
                assert.strictEqual(error.location?.startCol, col);
            });
        }

        it('refuses elements that cannot hold text in a document', () => {
            for (const html of ['<html [x]>', '<head [x]>', '<frameset [x]>', '<noscript [x]>']) {
                const options = { ...MT, scriptingEnabled: false };
                assert.strictEqual(
                    errorOf(() => parse(html, options)).code,
                    ErrorCodes.matchertextElementCannotHoldText,
                    html,
                );
            }
        });

        it('reports the line of the error', () => {
            assert.deepEqual(errorOf(() => parseFragment('<p>\n\n<div [(]>', MT)).location?.startLine, 3);
        });
    });

    it('contains a value exactly if it is matchertext', () => {
        const next = random(2);
        const alphabet = [
            '<',
            '>',
            '/',
            '"',
            "'",
            '&amp;',
            '</div>',
            '</script>',
            '<b>',
            '<!--',
            '-->',
            '<![MDATA[',
            ']]>',
            ']>',
            '[',
            ']',
            '(',
            ')',
            '{',
            '}',
            ' ',
            '\n',
            '\r',
            '\0',
            'x',
        ];

        // Whether `parse` gives the host tree with `value` in the hole. A refused input contains nothing. The
        // content of an element or attribute hole is balanced, so it can equal only a matchertext value.
        function contains(parse: () => ChildNode[], check: (nodes: ChildNode[]) => boolean): boolean {
            let nodes: ChildNode[];

            try {
                nodes = parse();
            } catch (error) {
                assert.ok(error instanceof MatchertextError, String(error));
                return false;
            }

            return check(nodes);
        }

        const names = (nodes: ChildNode[]): string => nodes.map((node) => node.nodeName).join(' ');
        const text = (node: ChildNode): string | null => {
            const [child, ...rest] = element(node).childNodes;

            if (!child) {
                return '';
            }

            return rest.length === 0 && child.nodeName === '#text' ? (child as TextNode).value : null;
        };

        for (let i = 0; i < 3000; i++) {
            const value = randomString(next, alphabet, 8);
            const valid = verifyMatchertext(value);
            const data = normalize(value);

            for (const tagName of ['div', 'script', 'textarea', 'style', 'pre']) {
                const html = `<i>a</i><${tagName} [${value}]><u>b</u>`;
                const contained = contains(
                    () => parseFragment(html, MT).childNodes,
                    (nodes) => names(nodes) === `i ${tagName} u` && text(nodes[1]) === data,
                );

                assert.strictEqual(contained, valid, html);
            }

            const attribute = `<i title=[${value}] id=z></i><u>b</u>`;
            const attributeContained = contains(
                () => parseFragment(attribute, MT).childNodes,
                (nodes) =>
                    names(nodes) === 'i u' &&
                    JSON.stringify(element(nodes[0]).attrs) ===
                        JSON.stringify([
                            { name: 'title', value: data },
                            { name: 'id', value: 'z' },
                        ]),
            );
            assert.strictEqual(attributeContained, valid, attribute);

            const section = `<p>a<![MDATA[${value}]]>b</p><u></u>`;
            const sectionContained = contains(
                () => parseFragment(section, MT).childNodes,
                (nodes) => names(nodes) === 'p u' && text(nodes[0]) === `a${data}b`,
            );
            // The text of a section merges with the text around it, where the rest of an unbalanced value can
            // land as text too, so only a matchertext value has a containment to check.
            if (valid) {
                assert.ok(sectionContained, section);
            }
        }
    });

    describe('chunked input', () => {
        const documents = [
            `<div [${CONTENT}]>after`,
            '<script [x = "</script>";]><p title=[a [b] c]>t</p>',
            '<p>a<![MDATA[<b>[x]</b>]]>b</p>',
            '<pre [\na\r\nb]><div [😀(😀)]>',
            '<textarea [\r\n</textarea>]>',
        ];

        function parseChunks(chunks: string[]): string {
            const parser = new Parser<DefaultTreeAdapterMap>(MT);

            for (const [i, chunk] of chunks.entries()) {
                parser.tokenizer.write(chunk, i === chunks.length - 1);
            }

            return serialize(parser.document, TREE);
        }

        it('gives the same tree at every split point', () => {
            for (const html of documents) {
                const expected = serialize(parse(html, MT), TREE);

                for (let k = 0; k <= html.length; k++) {
                    assert.strictEqual(parseChunks([html.slice(0, k), html.slice(k)]), expected, `${html} at ${k}`);
                }
            }
        });

        it('gives the same tree for random splits', () => {
            const next = random(3);

            for (const html of documents) {
                const expected = serialize(parse(html, MT), TREE);

                for (let i = 0; i < 200; i++) {
                    const a = Math.floor(next() * (html.length + 1));
                    const b = Math.floor(next() * (html.length + 1));
                    const [lo, hi] = a < b ? [a, b] : [b, a];
                    assert.strictEqual(
                        parseChunks([html.slice(0, lo), html.slice(lo, hi), html.slice(hi)]),
                        expected,
                        `${html} at ${lo}, ${hi}`,
                    );
                }
            }
        });

        it('reads input inserted in a hole', () => {
            const parser = new Parser<DefaultTreeAdapterMap>(MT);

            parser.tokenizer.write('<div [ab', false);
            parser.tokenizer.insertHtmlAtCurrentPos('c]>');
            parser.tokenizer.write('x', true);

            assert.strictEqual(serialize(parser.document, TREE), serialize(parse('<div [abc]>x', MT), TREE));
        });
    });

    describe('source code location', () => {
        const options = { ...MT, sourceCodeLocationInfo: true };

        it('covers the start tag, the content and the end tag of an element', () => {
            const html = '<div [a<b>]>x';
            const [hole] = parseFragment(html, options).childNodes;
            const location = element(hole).sourceCodeLocation;

            assert.ok(location?.startTag && location.endTag);
            assert.deepEqual([location.startTag.startOffset, location.startTag.endOffset], [0, 6]);
            assert.deepEqual([location.endTag.startOffset, location.endTag.endOffset], [10, 12]);
            assert.deepEqual([location.startOffset, location.endOffset], [0, 12]);

            const text = element(hole).childNodes[0];
            assert.deepEqual([text.sourceCodeLocation?.startOffset, text.sourceCodeLocation?.endOffset], [6, 10]);
        });

        it('covers an attribute with its brackets', () => {
            const [hole] = parseFragment('<a href=[x y] id=b>', options).childNodes;
            const attrs = element(hole).sourceCodeLocation?.attrs;

            assert.deepEqual([attrs?.['href'].startOffset, attrs?.['href'].endOffset], [3, 13]);
            assert.deepEqual([attrs?.['id'].startOffset, attrs?.['id'].endOffset], [14, 18]);
        });

        it('covers an MDATA section with its delimiters', () => {
            const [p] = parseFragment('<p><![MDATA[ab]]></p>', options).childNodes;
            const text = element(p).childNodes[0];

            assert.deepEqual([text.sourceCodeLocation?.startOffset, text.sourceCodeLocation?.endOffset], [3, 17]);
        });
    });

    it('keeps the legacy syntax without the option', () => {
        const html = '<input [value]="x"><a x=[y z]>a<![MDATA[m]]></a><div [c]>';

        assert.strictEqual(
            serialize(parseFragment(html)),
            '<input [value]="x"><a x="[y" z]="">a<!--[MDATA[m]]--></a><div [c]=""></div>',
        );
    });
});
