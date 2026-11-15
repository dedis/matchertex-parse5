import type { ERR } from './error-codes.js';
import type { Location } from './token.js';

/**
 * The maximum matcher nesting depth of a value. A deeper value is not matchertext. The limit is the one of the
 * SQLite implementation, so that a value that one implementation accepts the other accepts too.
 */
export const MAX_MATCHER_DEPTH = 1000;

/**
 * Classify a code unit or code point against the matcher pairs `()`, `[]` and `{}`. Return the pair kind 1, 2 or 3
 * for an opener, its negation for the closer of that pair, and 0 for a nonmatcher. Every matcher is ASCII, so no
 * code unit of a surrogate pair can be one.
 */
export function matcherKind(code: number): number {
    switch (code) {
        case 0x28: {
            return 1;
        }
        case 0x29: {
            return -1;
        }
        case 0x5b: {
            return 2;
        }
        case 0x5d: {
            return -2;
        }
        case 0x7b: {
            return 3;
        }
        case 0x7d: {
            return -3;
        }
        default: {
            return 0;
        }
    }
}

// The open matchers of `verifyMatchertext`, which does not re-enter, so one buffer serves every call.
const verifyStack = new Uint8Array(MAX_MATCHER_DEPTH);

/**
 * Report whether `value` is matchertext: its matcher pairs match and nest at most 1000 deep.
 * Only a matchertext value can be put in a matchertext hole, because only its matchers cannot close the hole.
 */
export function verifyMatchertext(value: string): boolean {
    let depth = 0;

    for (let i = 0; i < value.length; i++) {
        const kind = matcherKind(value.charCodeAt(i));

        if (kind > 0) {
            if (depth === MAX_MATCHER_DEPTH) {
                return false;
            }
            verifyStack[depth++] = kind;
        } else if (kind < 0) {
            if (depth === 0 || verifyStack[depth - 1] !== -kind) {
                return false;
            }
            depth--;
        }
    }

    return depth === 0;
}

/**
 * Thrown for input that matchertext refuses: a malformed hole, a value that is not matchertext, or a tree that the
 * serializer cannot write. The parser does not recover from it: discard the parser after this error.
 */
export class MatchertextError extends Error {
    constructor(
        public readonly code: ERR,
        /** The input position of the error, or `null` if the error has no input position. */
        public readonly location: Location | null,
    ) {
        super(location ? `${code} at ${location.startLine}:${location.startCol}` : code);
        this.name = 'MatchertextError';
    }
}
