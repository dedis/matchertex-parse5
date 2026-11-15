import { it, assert, describe } from 'vitest';
import { parseFragment, serialize, MatchertextError, ErrorCodes } from 'parse5';
import { RewritingStream } from '../lib/index.js';
import { finished, WritableStreamStub } from 'parse5-test-utils/utils/common.js';

const MT = { matchertext: true };

/** Rewrite `chunks` with the handlers that `assign` adds, and return the output or the stream error. */
async function rewrite(chunks: string[], assign: (rewriter: RewritingStream) => void): Promise<string | Error> {
    const rewriter = new RewritingStream(MT);
    const writable = new WritableStreamStub();
    const done = finished(rewriter);

    rewriter.pipe(writable);
    assign(rewriter);

    for (const chunk of chunks.slice(0, -1)) {
        rewriter.write(chunk);
    }
    rewriter.end(chunks[chunks.length - 1]);

    const error = await done.then(
        () => null,
        (error: unknown) => error as Error,
    );

    return error ?? (await finished(writable), writable.writtenData);
}

function codeOf(result: string | Error): string {
    assert.ok(result instanceof MatchertextError, String(result));
    return result.code;
}

const SOURCE = '<p id=a>x</p><div id=h [<b>(y)</b> "]><script [a = "</script>";]><pre [\nz]>';

describe('RewritingStream matchertext', () => {
    it('writes the source of unchanged tokens at every split point', async () => {
        for (let k = 0; k <= SOURCE.length; k++) {
            assert.strictEqual(await rewrite([SOURCE.slice(0, k), SOURCE.slice(k)], () => {}), SOURCE, `split at ${k}`);
        }
    });

    it('keeps the matchertext form of rewritten tags', async () => {
        const result = await rewrite([SOURCE], (rewriter) => {
            rewriter.on('startTag', (tag) => rewriter.emitStartTag(tag));
            rewriter.on('endTag', (tag) => rewriter.emitEndTag(tag));
        });

        assert.strictEqual(result, '<p id="a">x</p><div id="h" [<b>(y)</b> "]><script [a = "</script>";]><pre [\nz]>');
        assert.strictEqual(
            serialize(parseFragment(result as string, MT), { matchertextOutput: true }),
            serialize(parseFragment(SOURCE, MT), { matchertextOutput: true }),
        );
    });

    it('writes matchertext text into a matchertext element as it is', async () => {
        const result = await rewrite([SOURCE], (rewriter) => {
            rewriter.on('text', (text) => rewriter.emitText({ ...text, text: `[${text.text}] <i>` }));
        });

        assert.strictEqual(
            result,
            '<p id=a>[x] &lt;i&gt;</p><div id=h [[<b>(y)</b> "] <i>]><script [[a = "</script>";] <i>]><pre [[\nz] <i>]>',
        );
    });

    it('refuses text that is not matchertext in a matchertext element', async () => {
        for (const text of ['x]>', ']><img src=x onerror=alert(1)>', '(', '}']) {
            const result = await rewrite(['<div [y]>'], (rewriter) => {
                rewriter.on('text', () => rewriter.emitText({ text, sourceCodeLocation: null }));
            });

            assert.strictEqual(codeOf(result), ErrorCodes.matchertextInvalidArgument, text);
        }
    });

    it('refuses raw HTML, tags and comments that are not matchertext in a matchertext element', async () => {
        const emitters: ((rewriter: RewritingStream) => void)[] = [
            (rewriter): void => rewriter.emitRaw(']>'),
            (rewriter): void => rewriter.emitComment({ text: ']', sourceCodeLocation: null }),
            (rewriter): void =>
                rewriter.emitStartTag({
                    tagName: 'b',
                    attrs: [{ name: 'title', value: '[' }],
                    selfClosing: false,
                    sourceCodeLocation: null,
                }),
            (rewriter): void =>
                rewriter.emitStartTag({
                    tagName: 'b',
                    attrs: [],
                    selfClosing: false,
                    matchertext: true,
                    sourceCodeLocation: null,
                }),
        ];

        for (const emit of emitters) {
            const result = await rewrite(['<div [y]>'], (rewriter) => {
                rewriter.on('text', () => emit(rewriter));
            });

            assert.strictEqual(codeOf(result), ErrorCodes.matchertextInvalidArgument);
        }
    });

    it('escapes the text of a matchertext element whose start tag is not written', async () => {
        const source = '<div [<b>x</b>]><script [</script><img src=x onerror=alert(1)>]>';
        const result = await rewrite([source], (rewriter) => {
            rewriter.on('startTag', () => {});
        });

        assert.strictEqual(
            result,
            '&lt;b&gt;x&lt;/b&gt;</div>&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</script>',
        );
        assert.deepEqual(
            parseFragment(result as string).childNodes.map((node) => node.nodeName),
            ['#text'],
        );
    });

    it('fails the stream for malformed matchertext', async () => {
        assert.strictEqual(codeOf(await rewrite(['<div [a', ')]>'], () => {})), ErrorCodes.matchertextUnmatchedCloser);
    });
});
