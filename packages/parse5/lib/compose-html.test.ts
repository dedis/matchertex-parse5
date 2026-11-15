import { it, assert, describe } from 'vitest';
import { composeHtml, parse, serialize, verifyMatchertext, MatchertextError, ErrorCodes } from 'parse5';
import { random, randomString, treeAdapters } from 'parse5-test-utils/utils/common.js';

const MT = { matchertext: true };

function errorOf(compose: () => unknown): MatchertextError {
    try {
        compose();
    } catch (error) {
        assert.ok(error instanceof MatchertextError, String(error));
        return error;
    }

    throw new Error('Expected a MatchertextError');
}

describe('composeHtml', () => {
    it('puts values in element, section and attribute holes', () => {
        const document = composeHtml(
            ['<p title=[', '] [', ']><svg><![MDATA[', ']]></svg>'],
            ['a "t" [x]', '<b>not markup</b>', '</svg>'],
        );

        assert.strictEqual(
            serialize(document),
            '<html><head></head><body><p title="a &quot;t&quot; [x]">&lt;b&gt;not markup&lt;/b&gt;</p>' +
                '<svg>&lt;/svg&gt;</svg></body></html>',
        );
    });

    it('puts a value between template data of a hole', () => {
        assert.strictEqual(
            serialize(composeHtml(['<p [(', ' and ', ')]>'], ['a', 'b'])),
            serialize(parse('<p [(a and b)]>', MT)),
        );
    });

    it('normalizes values as input', () => {
        assert.strictEqual(
            serialize(composeHtml(['<p title=[', '] [', ']>'], ['a\r\nb\0', ' \r\0x'])),
            serialize(parse('<p title=[a\nb�] [ \n�x]>', MT)),
        );
    });

    it('gives the tree of the template with each value written in its hole', () => {
        const next = random(4);
        const alphabet = ['<', '>', '"', '&amp;', '</p>', '[', ']', '(', ')', '{', '}', ' ', '\n', 'x'];

        for (let i = 0; i < 2000; i++) {
            const value = randomString(next, alphabet, 8);

            if (!verifyMatchertext(value)) {
                continue;
            }

            for (const strings of [
                ['<p [', ']>'],
                ['<pre [', ']>'],
                ['<script [', ']>'],
                ['<a title=[', ']>'],
                ['<p><![MDATA[', ']]></p>'],
            ]) {
                assert.strictEqual(
                    serialize(composeHtml(strings, [value])),
                    serialize(parse(strings.join(value), MT)),
                    JSON.stringify([strings, value]),
                );
            }
        }
    });

    it('refuses a value that is not matchertext', () => {
        const error = errorOf(() => composeHtml(['<p [', ']>'], ['a]']));

        assert.strictEqual(error.code, ErrorCodes.matchertextInvalidArgument);
        assert.strictEqual(error.location, null);
    });

    it('refuses a value outside a hole', () => {
        for (const strings of [
            ['<p title="', '">'],
            ['<p>', '</p>'],
            ['<p ', '>'],
            ['', ''],
        ]) {
            assert.strictEqual(
                errorOf(() => composeHtml(strings, ['x'])).code,
                ErrorCodes.matchertextArgumentOutsideHole,
                JSON.stringify(strings),
            );
        }
    });

    it('refuses malformed matchertext in the template', () => {
        assert.strictEqual(
            errorOf(() => composeHtml(['<p [', ']x'], ['v'])).code,
            ErrorCodes.matchertextMissingTerminator,
        );
    });

    it('needs one more template string than values', () => {
        assert.throws(() => composeHtml(['<p [', ']>'], []), TypeError);
        assert.throws(() => composeHtml(['<p [', ']>'], ['a', 'b']), TypeError);
    });

    it('uses the given options', () => {
        const document = composeHtml(['<p [', ']>'], ['x'], { treeAdapter: treeAdapters.htmlparser2 });
        assert.strictEqual(
            serialize(document, { treeAdapter: treeAdapters.htmlparser2 }),
            serialize(parse('<p [x]>', MT)),
        );
    });
});
