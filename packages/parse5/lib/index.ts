import { Parser, type ParserOptions } from './parser/index.js';
import type { Tokenizer } from './tokenizer/index.js';

import type { DefaultTreeAdapterMap } from './tree-adapters/default.js';
import type { TreeAdapterTypeMap } from './tree-adapters/interface.js';

export { type DefaultTreeAdapterMap, defaultTreeAdapter } from './tree-adapters/default.js';
import type * as DefaultTreeAdapter from './tree-adapters/default.js';
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace DefaultTreeAdapterTypes {
    export type Document = DefaultTreeAdapter.Document;
    export type DocumentFragment = DefaultTreeAdapter.DocumentFragment;
    export type Element = DefaultTreeAdapter.Element;
    export type CommentNode = DefaultTreeAdapter.CommentNode;
    export type TextNode = DefaultTreeAdapter.TextNode;
    export type Template = DefaultTreeAdapter.Template;
    export type DocumentType = DefaultTreeAdapter.DocumentType;
    export type ParentNode = DefaultTreeAdapter.ParentNode;
    export type ChildNode = DefaultTreeAdapter.ChildNode;
    export type Node = DefaultTreeAdapter.Node;
    export type DefaultTreeAdapterMap = DefaultTreeAdapter.DefaultTreeAdapterMap;
}
export type { ElementCreationContext, TreeAdapter, TreeAdapterTypeMap } from './tree-adapters/interface.js';
export { type ParserOptions, /** @internal */ Parser, InsertionMode } from './parser/index.js';
export { serialize, serializeOuter, type SerializerOptions } from './serializer/index.js';
export { ERR as ErrorCodes, type ParserError, type ParserErrorHandler } from './common/error-codes.js';
export { MatchertextError, verifyMatchertext } from './common/matchertext.js';

/** @internal */
export * as foreignContent from './common/foreign-content.js';
export * as html from './common/html.js';
export * as Token from './common/token.js';
/** @internal */
export { Tokenizer, type TokenizerOptions, TokenizerMode, type TokenHandler } from './tokenizer/index.js';

// Shorthands

/**
 * Parses an HTML string.
 *
 * @param html Input HTML string.
 * @param options Parsing options.
 * @returns Document
 *
 * @example
 *
 * ```js
 * const parse5 = require('parse5');
 *
 * const document = parse5.parse('<!DOCTYPE html><html><head></head><body>Hi there!</body></html>');
 *
 * console.log(document.childNodes[1].tagName); //> 'html'
 *```
 */
export function parse<T extends TreeAdapterTypeMap = DefaultTreeAdapterMap>(
    html: string,
    options?: ParserOptions<T>,
): T['document'] {
    return Parser.parse(html, options);
}

/**
 * Parses an HTML fragment.
 *
 * @example
 *
 * ```js
 * const parse5 = require('parse5');
 *
 * const documentFragment = parse5.parseFragment('<table></table>');
 *
 * console.log(documentFragment.childNodes[0].tagName); //> 'table'
 *
 * // Parses the html fragment in the context of the parsed <table> element.
 * const trFragment = parse5.parseFragment(documentFragment.childNodes[0], '<tr><td>Shake it, baby</td></tr>');
 *
 * console.log(trFragment.childNodes[0].childNodes[0].tagName); //> 'td'
 * ```
 *
 * @param fragmentContext Parsing context element. If specified, given fragment will be parsed as if it was set to the context element's `innerHTML` property.
 * @param html Input HTML fragment string.
 * @param options Parsing options.
 * @returns DocumentFragment
 */
export function parseFragment<T extends TreeAdapterTypeMap = DefaultTreeAdapterMap>(
    fragmentContext: T['parentNode'] | null,
    html: string,
    options: ParserOptions<T>,
): T['documentFragment'];
export function parseFragment<T extends TreeAdapterTypeMap = DefaultTreeAdapterMap>(
    html: string,
    options?: ParserOptions<T>,
): T['documentFragment'];
export function parseFragment<T extends TreeAdapterTypeMap = DefaultTreeAdapterMap>(
    fragmentContext: T['parentNode'] | null | string,
    html?: string | ParserOptions<T>,
    options?: ParserOptions<T>,
): T['documentFragment'] {
    if (typeof fragmentContext === 'string') {
        options = html as ParserOptions<T>;
        html = fragmentContext;
        fragmentContext = null;
    }

    const parser = Parser.getFragmentParser(fragmentContext, options);

    parser.tokenizer.write(html as string, true);

    return parser.getFragment();
}

/**
 * A value of an {@link htmlTemplate}: a string goes into a matchertext hole as data; a template or an array of
 * values is written in its place.
 */
export type HtmlTemplateValue = string | HtmlTemplate | readonly HtmlTemplateValue[];

/** A matchertext HTML template, made only by {@link htmlTemplate}. */
export interface HtmlTemplate {
    readonly strings: readonly string[];
    readonly values: readonly HtmlTemplateValue[];
}

const templates = new WeakSet<HtmlTemplate>();

/** Nesting limit of templates and arrays in {@link composeHtml}. */
const MAX_TEMPLATE_DEPTH = 1000;

/**
 * Makes a matchertext HTML template from a tagged template literal. The markup comes only from template literals of
 * the program: a call with an array that is not a template object throws a `TypeError`. The template may be built at
 * run time from nested templates and arrays of them; a string value enters only as data of a hole.
 *
 * A caller that freezes an array of its own with a frozen `raw` array passes this check, and so opts out of it.
 *
 * @example
 *
 * ```js
 * const { composeHtml, htmlTemplate } = require('parse5');
 *
 * const items = ['a', '<b>not markup</b>'].map((item) => htmlTemplate`<li [${item}]>`);
 * const document = composeHtml(htmlTemplate`<ul title=[${'a "title"'}]>${items}</ul>`);
 * ```
 */
export function htmlTemplate(strings: TemplateStringsArray, ...values: HtmlTemplateValue[]): HtmlTemplate {
    // A template object is frozen, as is its raw array; an array built at run time is not.
    if (
        !Array.isArray(strings) ||
        !Object.isFrozen(strings) ||
        !Array.isArray(strings.raw) ||
        !Object.isFrozen(strings.raw) ||
        strings.raw.length !== strings.length ||
        strings.length !== values.length + 1
    ) {
        throw new TypeError('htmlTemplate must be used as a tag of a template literal');
    }

    if ((strings as readonly (string | undefined)[]).includes(undefined)) {
        throw new TypeError('htmlTemplate needs a template literal without invalid escapes');
    }

    const template: HtmlTemplate = Object.freeze({ strings, values: Object.freeze(values) });

    templates.add(template);

    return template;
}

function writeTemplateValue(tokenizer: Tokenizer, value: unknown, depth: number): void {
    if (depth > MAX_TEMPLATE_DEPTH) {
        throw new TypeError('composeHtml templates nest too deeply');
    }

    if (typeof value === 'string') {
        tokenizer.insertMatchertextValue(value);
    } else if (Array.isArray(value)) {
        for (const item of value) {
            writeTemplateValue(tokenizer, item, depth + 1);
        }
    } else if (templates.has(value as HtmlTemplate)) {
        const { strings, values } = value as HtmlTemplate;

        for (let i = 0; i < values.length; i++) {
            tokenizer.write(strings[i], false);
            writeTemplateValue(tokenizer, values[i], depth + 1);
        }

        tokenizer.write(strings[values.length], false);
    } else {
        throw new TypeError('composeHtml takes strings, and templates made by htmlTemplate');
    }
}

/**
 * Parses an HTML document from a matchertext template made by {@link htmlTemplate}. The template must put each string
 * value in a matchertext hole: the content of an element `<tag [...]>` or section `<![MDATA[...]]>`, or an attribute
 * value `name=[...]`. A value becomes data of its hole without being tokenized, normalized as input is. Each value
 * must be matchertext.
 *
 * Throws a `TypeError` for a template not made by {@link htmlTemplate}, and a {@link MatchertextError} for a value
 * that is not matchertext, a value outside a hole, or malformed matchertext in the template.
 *
 * @example
 *
 * ```js
 * const { composeHtml, htmlTemplate } = require('parse5');
 *
 * const document = composeHtml(htmlTemplate`<p title=[${'a "title"'}] [${'<b>not markup</b>'}]>`);
 * ```
 *
 * @param template The template.
 * @param options Parsing options. The matchertext syntax is always enabled.
 */
export function composeHtml<T extends TreeAdapterTypeMap = DefaultTreeAdapterMap>(
    template: HtmlTemplate,
    options?: ParserOptions<T>,
): T['document'] {
    if (!templates.has(template)) {
        throw new TypeError('composeHtml takes a template made by htmlTemplate');
    }

    const parser = new Parser<T>({ ...options, matchertext: true });

    writeTemplateValue(parser.tokenizer, template, 0);
    parser.tokenizer.write('', true);

    return parser.document;
}
