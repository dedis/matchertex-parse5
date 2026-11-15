import { it, assert, describe } from 'vitest';
import { verifyMatchertext, MatchertextError, ErrorCodes } from 'parse5';
import { MAX_MATCHER_DEPTH, matcherKind } from './matchertext.js';
import { random, randomString } from 'parse5-test-utils/utils/common.js';

/** An oracle that does not use a stack: remove matched innermost pairs until none is left. */
function isBalanced(value: string): boolean {
    let s = value.replace(/[^()[\]{}]/g, '');

    // Each pass removes at least one pair, so `s.length / 2` passes remove all of them.
    for (let pass = 0; pass <= value.length; pass++) {
        const reduced = s.replace(/\(\)|\[\]|\{\}/g, '');

        if (reduced === s) {
            return s === '';
        }
        s = reduced;
    }

    throw new Error('unreachable');
}

describe('matchertext scanner', () => {
    it('classifies the six matchers', () => {
        assert.deepEqual(
            [...'()[]{}a<\0'].map((c) => matcherKind(c.charCodeAt(0))),
            [1, -1, 2, -2, 3, -3, 0, 0, 0],
        );
        assert.strictEqual(matcherKind(0x1_f6_00), 0);
    });

    it('verifies balanced values', () => {
        for (const value of ['', 'text', 'call(item[index])', '{[()]}', '"\'<>&', '😀(x)', 'a\0b']) {
            assert.ok(verifyMatchertext(value), value);
        }
    });

    it('rejects unbalanced values', () => {
        for (const value of ['text]', '([)]', '(', ')', '}{', 'a[b', 'smile :]']) {
            assert.ok(!verifyMatchertext(value), value);
        }
    });

    it('limits the nesting depth', () => {
        assert.ok(verifyMatchertext('('.repeat(MAX_MATCHER_DEPTH) + ')'.repeat(MAX_MATCHER_DEPTH)));
        assert.ok(!verifyMatchertext('('.repeat(MAX_MATCHER_DEPTH + 1) + ')'.repeat(MAX_MATCHER_DEPTH + 1)));
    });

    it('agrees with an oracle on random values', () => {
        const next = random(1);
        const alphabet = ['(', ')', '[', ']', '{', '}', 'a', '<', '"', '😀'];

        for (let i = 0; i < 20_000; i++) {
            const value = randomString(next, alphabet, 12);
            assert.strictEqual(verifyMatchertext(value), isBalanced(value), JSON.stringify(value));
        }
    });

    it('names the error code and position', () => {
        const error = new MatchertextError(ErrorCodes.eofInMatchertext, {
            startLine: 2,
            startCol: 5,
            startOffset: 9,
            endLine: 2,
            endCol: 5,
            endOffset: 9,
        });

        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, 'MatchertextError');
        assert.strictEqual(error.code, ErrorCodes.eofInMatchertext);
        assert.strictEqual(error.message, 'eof-in-matchertext at 2:5');
        assert.strictEqual(
            new MatchertextError(ErrorCodes.matchertextInvalidArgument, null).message,
            'matchertext-invalid-argument',
        );
    });
});
