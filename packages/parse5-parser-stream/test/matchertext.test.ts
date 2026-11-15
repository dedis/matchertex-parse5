import { it, assert, describe } from 'vitest';
import { parse, serialize, MatchertextError, ErrorCodes } from 'parse5';
import { ParserStream } from '../lib/index.js';
import { finished } from 'parse5-test-utils/utils/common.js';

const MT = { matchertext: true };
// Writes every tree of matchertext input, to compare trees.
const TREE = { matchertextOutput: true };

async function failure(stream: ParserStream): Promise<MatchertextError> {
    const error = await finished(stream).then(
        () => null,
        (error: unknown) => error,
    );

    assert.ok(error instanceof MatchertextError, String(error));
    return error;
}

describe('ParserStream matchertext', () => {
    it('gives the tree of one write at every split point', async () => {
        const html = '<script [x = "</script>" [a]]><p title=[t [u]]><![MDATA[<b>]]></p>';
        const expected = serialize(parse(html, MT), TREE);

        for (let k = 0; k <= html.length; k++) {
            const parser = new ParserStream(MT);

            parser.write(html.slice(0, k));
            parser.end(html.slice(k));
            await finished(parser);

            assert.strictEqual(serialize(parser.document, TREE), expected, `split at ${k}`);
        }
    });

    it('fails the stream for malformed matchertext', async () => {
        const parser = new ParserStream(MT);
        const error = failure(parser);

        parser.write('<div [a');
        parser.end(')]>');

        const { code } = await error;
        assert.strictEqual(code, ErrorCodes.matchertextUnmatchedCloser);
    });

    it('fails the stream for malformed matchertext after a script resumes', async () => {
        const parser = new ParserStream(MT);
        const error = failure(parser);

        parser.on('script', (_element, _documentWrite, resume) => resume());
        parser.end('<script [a]><div [(]>');

        const { code } = await error;
        assert.strictEqual(code, ErrorCodes.matchertextUnmatchedCloser);
    });
});
