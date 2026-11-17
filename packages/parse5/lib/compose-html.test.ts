import { it, assert, describe } from 'vitest';
import {
    composeHtml,
    htmlTemplate,
    parse,
    serialize,
    verifyMatchertext,
    MatchertextError,
    ErrorCodes,
    type HtmlTemplate,
    type HtmlTemplateValue,
} from 'parse5';
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
            htmlTemplate`<p title=[${'a "t" [x]'}] [${'<b>not markup</b>'}]><svg><![MDATA[${'</svg>'}]]></svg>`,
        );

        assert.strictEqual(
            serialize(document),
            '<html><head></head><body><p title="a &quot;t&quot; [x]">&lt;b&gt;not markup&lt;/b&gt;</p>' +
                '<svg>&lt;/svg&gt;</svg></body></html>',
        );
    });

    it('puts a value between template data of a hole', () => {
        assert.strictEqual(
            serialize(composeHtml(htmlTemplate`<p [(${'a'} and ${'b'})]>`)),
            serialize(parse('<p [(a and b)]>', MT)),
        );
    });

    it('normalizes values as input', () => {
        assert.strictEqual(
            serialize(composeHtml(htmlTemplate`<p title=[${'a\r\nb\0'}] [${' \r\0x'}]>`)),
            serialize(parse('<p title=[a\nb\uFFFD] [ \n\uFFFDx]>', MT)),
        );
    });

    it('gives the tree of the template with each value written in its hole', () => {
        const next = random(4);
        const alphabet = ['<', '>', '"', '&amp;', '</p>', '[', ']', '(', ')', '{', '}', ' ', '\n', 'x'];
        const hosts: [(value: string) => HtmlTemplate, string[]][] = [
            [(v): HtmlTemplate => htmlTemplate`<p [${v}]>`, ['<p [', ']>']],
            [(v): HtmlTemplate => htmlTemplate`<pre [${v}]>`, ['<pre [', ']>']],
            [(v): HtmlTemplate => htmlTemplate`<script [${v}]>`, ['<script [', ']>']],
            [(v): HtmlTemplate => htmlTemplate`<a title=[${v}]>`, ['<a title=[', ']>']],
            [(v): HtmlTemplate => htmlTemplate`<p><![MDATA[${v}]]></p>`, ['<p><![MDATA[', ']]></p>']],
        ];

        for (let i = 0; i < 2000; i++) {
            const value = randomString(next, alphabet, 8);

            if (!verifyMatchertext(value)) {
                continue;
            }

            for (const [host, strings] of hosts) {
                assert.strictEqual(
                    serialize(composeHtml(host(value))),
                    serialize(parse(strings.join(value), MT)),
                    JSON.stringify([strings, value]),
                );
            }
        }
    });

    it('composes nested templates and arrays at run time', () => {
        const items = ['a', '<b>', ''].map((item) => htmlTemplate`<li [${item}]>`);
        const head = htmlTemplate`<p title=[${'t'}]>`;

        assert.strictEqual(
            serialize(composeHtml(htmlTemplate`${head}<ul>${items}${[]}</ul>`)),
            serialize(parse('<p title=[t]><ul><li [a]><li [<b>]><li []></ul>', MT)),
        );
    });

    it('refuses markup that is not a template literal', () => {
        const forged = ['<p [', ']>'];

        assert.throws(() => htmlTemplate(forged as unknown as TemplateStringsArray, 'x'), TypeError);
        assert.throws(() => htmlTemplate(Object.freeze(forged) as unknown as TemplateStringsArray, 'x'), TypeError);
        assert.throws(() => composeHtml({ strings: forged, values: ['x'] } as unknown as HtmlTemplate), TypeError);
        assert.throws(() => composeHtml(htmlTemplate`<p>${{} as unknown as string}</p>`), TypeError);
    });

    it('limits nesting', () => {
        const cycle: unknown[] = [];

        cycle.push(cycle);
        assert.throws(() => composeHtml(htmlTemplate`<p>${cycle as HtmlTemplateValue[]}</p>`), TypeError);
    });

    it('refuses a value that is not matchertext', () => {
        const error = errorOf(() => composeHtml(htmlTemplate`<p [${'a]'}]>`));

        assert.strictEqual(error.code, ErrorCodes.matchertextInvalidArgument);
        assert.strictEqual(error.location, null);
    });

    it('refuses a value outside a hole', () => {
        for (const host of [
            (v: string): HtmlTemplate => htmlTemplate`<p title="${v}">`,
            (v: string): HtmlTemplate => htmlTemplate`<p>${v}</p>`,
            (v: string): HtmlTemplate => htmlTemplate`<p ${v}>`,
            (v: string): HtmlTemplate => htmlTemplate`${v}`,
            (v: string): HtmlTemplate => htmlTemplate`<p>${[v]}</p>`,
        ]) {
            assert.strictEqual(
                errorOf(() => composeHtml(host('x'))).code,
                ErrorCodes.matchertextArgumentOutsideHole,
                host.toString(),
            );
        }
    });

    it('refuses malformed matchertext in the template', () => {
        assert.strictEqual(
            errorOf(() => composeHtml(htmlTemplate`<p x=[${'v'})]>`)).code,
            ErrorCodes.matchertextUnmatchedCloser,
        );
    });

    it('refuses a value after a `[` that starts an attribute name', () => {
        // The matched `]` is not followed by `>`, so the `[` opens no element content.
        for (const host of [
            (v: string): HtmlTemplate => htmlTemplate`<p [${v}]x>`,
            (v: string): HtmlTemplate => htmlTemplate`<p [${v}]="y">`,
            (v: string): HtmlTemplate => htmlTemplate`<p [${v}`,
        ]) {
            assert.strictEqual(
                errorOf(() => composeHtml(host('x'))).code,
                ErrorCodes.matchertextArgumentOutsideHole,
                host.toString(),
            );
        }
    });

    it('puts values in an element hole whose `]>` comes in a later piece', () => {
        const document = composeHtml(htmlTemplate`<p [${'a'}(${'b'})${'c'}]>`);
        assert.strictEqual(serialize(document), serialize(parse('<p [a(b)c]>', MT)));
    });

    it('uses the given options', () => {
        const document = composeHtml(htmlTemplate`<p [${'x'}]>`, { treeAdapter: treeAdapters.htmlparser2 });
        assert.strictEqual(
            serialize(document, { treeAdapter: treeAdapters.htmlparser2 }),
            serialize(parse('<p [x]>', MT)),
        );
    });
});
