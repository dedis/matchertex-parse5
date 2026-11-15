import { it, assert, describe } from 'vitest';
import {
    parse,
    parseFragment,
    serialize,
    defaultTreeAdapter,
    html,
    MatchertextError,
    ErrorCodes,
    type DefaultTreeAdapterTypes,
    type SerializerOptions,
    type DefaultTreeAdapterMap,
} from 'parse5';

type DocumentFragment = DefaultTreeAdapterTypes.DocumentFragment;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type CommentNode = DefaultTreeAdapterTypes.CommentNode;

// The fragment serialization algorithm, without the guard.
const STOCK: SerializerOptions<DefaultTreeAdapterMap> = { matchertext: false };

function errorOf(serialize: () => unknown): MatchertextError {
    try {
        serialize();
    } catch (error) {
        assert.ok(error instanceof MatchertextError, String(error));
        return error;
    }

    throw new Error('Expected a MatchertextError');
}

/** A fragment `<tagName>text</tagName><i></i>`, built as a tree so that `text` is not parsed. */
function rawTextFragment(tagName: string, text: string): DocumentFragment {
    const fragment = defaultTreeAdapter.createDocumentFragment();
    const element = defaultTreeAdapter.createElement(tagName, html.NS.HTML, []);

    defaultTreeAdapter.insertText(element, text);
    defaultTreeAdapter.appendChild(fragment, element);
    defaultTreeAdapter.appendChild(fragment, defaultTreeAdapter.createElement('i', html.NS.HTML, []));
    return fragment;
}

/** Whether a parser reads `html` back as `<tagName>text</tagName><i></i>`. */
function readsBackRawText(html: string, tagName: string, text: string): boolean {
    const nodes = parseFragment(html).childNodes;

    return (
        nodes.length === 2 &&
        nodes[0].nodeName === tagName &&
        serialize(nodes[0] as Element) === text &&
        nodes[1].nodeName === 'i'
    );
}

/** Every concatenation of exactly `length` pieces of `alphabet`. */
function* products(alphabet: readonly string[], length: number): Generator<string> {
    if (length === 0) {
        yield '';
        return;
    }

    for (const prefix of products(alphabet, length - 1)) {
        for (const piece of alphabet) {
            yield prefix + piece;
        }
    }
}

describe('matchertext serializer', () => {
    it('keeps the output of the fragment serialization algorithm without the guard', () => {
        const fragment = rawTextFragment('script', 'a</script><b>');
        assert.strictEqual(serialize(fragment, STOCK), '<script>a</script><b></script><i></i>');
    });

    for (const [tagName, alphabet] of [
        [
            'script',
            ['</script>', '</script', '</SCRIPT/', '<script>', '<script', '<!--', '-->', '-', '<', '>', ' ', 'x'],
        ],
        ['style', ['</style>', '</style', '</STYLE\t', '<!--', '-->', '<', '/', '>', 'x']],
        ['noembed', ['</noembed>', '</noembed', '<', 'x']],
        ['plaintext', ['</plaintext>', '<', 'x']],
    ] as const) {
        it(`refuses <${tagName}> text exactly when a parser would end the element early`, () => {
            for (let length = 0; length <= 4; length++) {
                for (const text of products(alphabet, length)) {
                    const fragment = rawTextFragment(tagName, text);
                    const stock = serialize(fragment, STOCK);
                    let guarded: string | null = null;

                    try {
                        guarded = serialize(fragment);
                    } catch (error) {
                        assert.ok(error instanceof MatchertextError);
                        assert.strictEqual(error.code, ErrorCodes.matchertextUnserializableText);
                    }

                    assert.strictEqual(guarded === null, !readsBackRawText(stock, tagName, text), JSON.stringify(text));

                    if (guarded !== null) {
                        assert.strictEqual(guarded, stock);
                    }
                }
            }
        });
    }

    it('treats a CR as the end of a tag name', () => {
        assert.strictEqual(
            errorOf(() => serialize(rawTextFragment('script', '</script\r'))).code,
            ErrorCodes.matchertextUnserializableText,
        );
    });

    it('refuses raw text with a child that is not text', () => {
        const fragment = parseFragment('<style></style>');
        const style = fragment.childNodes[0] as Element;
        defaultTreeAdapter.appendChild(style, defaultTreeAdapter.createElement('b', style.namespaceURI, []));

        assert.strictEqual(errorOf(() => serialize(fragment)).code, ErrorCodes.matchertextUnserializableText);
    });

    it('writes escaped noscript text without the scripting flag', () => {
        const fragment = rawTextFragment('noscript', '</noscript>');

        assert.strictEqual(
            serialize(fragment, { scriptingEnabled: false }),
            '<noscript>&lt;/noscript&gt;</noscript><i></i>',
        );
        assert.strictEqual(errorOf(() => serialize(fragment)).code, ErrorCodes.matchertextUnserializableText);
    });

    it('refuses comment data exactly when a parser would read it back differently', () => {
        for (const data of Array.from({ length: 7 }, (_, length) => [
            ...products(['<', '!', '-', '>', 'a'], length),
        ]).flat()) {
            const fragment = parseFragment('<i></i>');
            defaultTreeAdapter.insertBefore(
                fragment,
                defaultTreeAdapter.createCommentNode(data),
                fragment.childNodes[0],
            );
            const stock = serialize(fragment, STOCK);
            const nodes = parseFragment(stock).childNodes;
            const readsBack =
                nodes.length === 2 && nodes[0].nodeName === '#comment' && (nodes[0] as CommentNode).data === data;
            let refused = false;

            try {
                serialize(fragment);
            } catch (error) {
                assert.ok(error instanceof MatchertextError);
                assert.strictEqual(error.code, ErrorCodes.matchertextUnserializableComment);
                refused = true;
            }

            assert.strictEqual(refused, !readsBack, JSON.stringify(data));
        }
    });

    it('writes the leading line feed that a parser drops', () => {
        for (const tagName of ['pre', 'textarea', 'listing']) {
            const document = parse(`<${tagName} [\n\nx]>`, { matchertext: true });
            const reparsed = parse(serialize(document));
            const element = reparsed.childNodes[0] as Element;
            const body = element.childNodes[1] as Element;
            const text = (body.childNodes[0] as Element).childNodes[0] as TextNode;

            assert.strictEqual(text.value, '\n\nx', tagName);
        }
    });

    describe('matchertext output', () => {
        it('writes refused raw text as a matchertext element', () => {
            const fragment = rawTextFragment('script', 'x = "</script>" [a] (b)');
            const html = serialize(fragment, { matchertextOutput: true });

            assert.strictEqual(html, '<script [x = "</script>" [a] (b)]><i></i>');
            assert.strictEqual(
                serialize(parseFragment(html, { matchertext: true }), { matchertextOutput: true }),
                serialize(fragment, { matchertextOutput: true }),
            );
        });

        it('writes plaintext as a matchertext element', () => {
            const fragment = rawTextFragment('plaintext', 'a</plaintext>');
            const html = serialize(fragment, { matchertextOutput: true });

            assert.strictEqual(html, '<plaintext [a</plaintext>]><i></i>');
            assert.strictEqual(
                serialize(parseFragment(html, { matchertext: true }), { matchertextOutput: true }),
                serialize(fragment, { matchertextOutput: true }),
            );
        });

        it('keeps the attributes of the element', () => {
            const fragment = parseFragment('<style media="a&quot;"></style>');
            defaultTreeAdapter.insertText(fragment.childNodes[0] as Element, '</style>');

            assert.strictEqual(serialize(fragment, { matchertextOutput: true }), '<style media="a&quot;" [</style>]>');
        });

        it('writes representable raw text as standard HTML', () => {
            const fragment = rawTextFragment('script', 'a < b');
            assert.strictEqual(serialize(fragment, { matchertextOutput: true }), '<script>a < b</script><i></i>');
        });

        it('refuses raw text that is not matchertext', () => {
            assert.strictEqual(
                errorOf(() => serialize(rawTextFragment('script', '</script> ]'), { matchertextOutput: true })).code,
                ErrorCodes.matchertextUnserializableText,
            );
        });
    });
});
