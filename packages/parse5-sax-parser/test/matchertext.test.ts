import { it, assert, describe } from 'vitest';
import { MatchertextError, ErrorCodes } from 'parse5';
import { SAXParser, type SAXParserOptions } from '../lib/index.js';
import { finished } from 'parse5-test-utils/utils/common.js';

async function events(html: string, options: SAXParserOptions): Promise<string[]> {
    const parser = new SAXParser(options);
    const result: string[] = [];

    parser.on('startTag', ({ tagName, attrs }) => {
        result.push(`<${tagName}${attrs.map(({ name, value }) => ` ${name}=${value}`).join('')}>`);
    });
    parser.on('endTag', ({ tagName }) => result.push(`</${tagName}>`));
    parser.on('text', ({ text }) => result.push(JSON.stringify(text)));
    parser.end(html);
    await finished(parser);

    return result;
}

describe('SAX parser matchertext', () => {
    it('emits the content of a matchertext element as one text', async () => {
        assert.deepEqual(await events('<script [a = "</script>" [b]]><p title=[x y]>', { matchertext: true }), [
            '<script>',
            String.raw`"a = \"</script>\" [b]"`,
            '</script>',
            '<p title=x y>',
        ]);
    });

    it('emits the content of a matchertext element as one text at every split point', async () => {
        const html = '<div [a b\n(c) <i>\0]><p title=[x]>';

        for (let k = 0; k <= html.length; k++) {
            const parser = new SAXParser({ matchertext: true });
            const result: unknown[] = [];

            parser.on('startTag', ({ tagName, matchertext }) => result.push(['start', tagName, matchertext]));
            parser.on('endTag', ({ tagName, matchertext }) => result.push(['end', tagName, matchertext]));
            parser.on('text', ({ text }) => result.push(['text', text]));
            parser.write(html.slice(0, k));
            parser.end(html.slice(k));
            await finished(parser);

            assert.deepEqual(
                result,
                [
                    ['start', 'div', true],
                    ['text', 'a b\n(c) <i>\uFFFD'],
                    ['end', 'div', true],
                    ['start', 'p', undefined],
                ],
                `split at ${k}`,
            );
        }
    });

    it('keeps a leading line feed', async () => {
        assert.deepEqual(await events('<pre [\nx]>', { matchertext: true }), ['<pre>', String.raw`"\nx"`, '</pre>']);
    });

    it('fails the stream for malformed matchertext', async () => {
        const parser = new SAXParser({ matchertext: true });
        const done = finished(parser);

        parser.end('<div x=[a');

        const error = await done.then(
            () => null,
            (error: unknown) => error,
        );
        assert.ok(error instanceof MatchertextError);
        assert.strictEqual(error.code, ErrorCodes.eofInMatchertext);
    });

    it('keeps the legacy syntax without the option', async () => {
        assert.deepEqual(await events('<div [a]>', {}), ['<div [a]=>']);
    });
});
