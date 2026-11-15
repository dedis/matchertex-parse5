import { TAG_NAMES as $, NS, hasUnescapedText } from '../common/html.js';
import { escapeText, escapeAttribute } from 'entities/escape';
import type { TreeAdapter, TreeAdapterTypeMap } from '../tree-adapters/interface.js';
import { defaultTreeAdapter, type DefaultTreeAdapterMap } from '../tree-adapters/default.js';
import { ERR } from '../common/error-codes.js';
import { MatchertextError, verifyMatchertext } from '../common/matchertext.js';

// Sets
const VOID_ELEMENTS = new Set<string>([
    $.AREA,
    $.BASE,
    $.BASEFONT,
    $.BGSOUND,
    $.BR,
    $.COL,
    $.EMBED,
    $.FRAME,
    $.HR,
    $.IMG,
    $.INPUT,
    $.KEYGEN,
    $.LINK,
    $.META,
    $.PARAM,
    $.SOURCE,
    $.TRACK,
    $.WBR,
]);

function isVoidElement<T extends TreeAdapterTypeMap>(node: T['node'], options: InternalOptions<T>): boolean {
    return (
        options.treeAdapter.isElementNode(node) &&
        options.treeAdapter.getNamespaceURI(node) === NS.HTML &&
        VOID_ELEMENTS.has(options.treeAdapter.getTagName(node))
    );
}

export interface SerializerOptions<T extends TreeAdapterTypeMap> {
    /**
     * Specifies input tree format.
     *
     * @default `treeAdapters.default`
     */
    treeAdapter?: TreeAdapter<T>;
    /**
     * The [scripting flag](https://html.spec.whatwg.org/multipage/parsing.html#scripting-flag). If set
     * to `true`, `noscript` element content will not be escaped.
     *
     *  @default `true`
     */
    scriptingEnabled?: boolean;
    /**
     * Refuses a tree that a parser would read back with a different structure, and throws a `MatchertextError` for
     * it: raw text that contains the end tag of its element or that has a child which is not text, `plaintext`,
     * which no end tag ends, and comment data that ends the comment. Also writes the line feed that a parser drops
     * at the start of `pre`, `textarea` and `listing` content. The line breaks and NUL characters that a parser
     * normalizes are not kept.
     *
     * Set to `false` for the output of the HTML fragment serialization algorithm, which can write such a tree as
     * markup that a parser reads as other elements.
     *
     * @default `true`
     */
    matchertext?: boolean;
    /**
     * Writes a raw text element that {@link SerializerOptions.matchertext} refuses as the matchertext element
     * `<tag attrs [text]>` if its text is matchertext. Only a matchertext parser reads such output. Implies
     * {@link SerializerOptions.matchertext}.
     *
     * @default `false`
     */
    matchertextOutput?: boolean;
}

type InternalOptions<T extends TreeAdapterTypeMap> = Required<SerializerOptions<T>>;

const defaultOpts: InternalOptions<DefaultTreeAdapterMap> = {
    treeAdapter: defaultTreeAdapter,
    scriptingEnabled: true,
    matchertext: true,
    matchertextOutput: false,
};

// Elements whose content a parser reads without a leading line feed.
const LEADING_LINE_FEED_DROPPED = new Set<string>([$.PRE, $.TEXTAREA, $.LISTING]);

/**
 * Report whether `s` has at offset `i` a tag start: `prefix`, then `name` in any ASCII case, then a character that
 * ends a tag name. At the end of `s`, the end tag written after `s` continues the tag name, so that is no tag start.
 */
function tagAt(s: string, i: number, prefix: string, name: string): boolean {
    const nameStart = i + prefix.length;
    const nameEnd = nameStart + name.length;

    if (nameEnd >= s.length || !s.startsWith(prefix, i)) {
        return false;
    }

    for (let k = 0; k < name.length; k++) {
        const c = s.charCodeAt(nameStart + k);

        if ((c >= 0x41 && c <= 0x5a ? c + 0x20 : c) !== name.charCodeAt(k)) {
            return false;
        }
    }

    return '\t\n\f\r />'.includes(s[nameEnd]);
}

/**
 * Report whether a parser, reading `text` as the content of the raw text element `tn`, would not end the element
 * at the end tag written after `text`: because `text` contains that end tag, because `text` is a script that
 * leaves the parser in the state in which that end tag does not end the script, or because no end tag ends
 * `plaintext`.
 *
 * @see {@link https://html.spec.whatwg.org/multipage/parsing.html#script-data-state}
 */
function rawTextEndsEarly(tn: string, text: string): boolean {
    if (tn === $.PLAINTEXT) {
        return true;
    }

    const DATA = 0; // An end tag ends the element.
    const ESCAPED = 1; // After `<!--`: an end tag ends the element.
    const DOUBLE_ESCAPED = 2; // After `<!--<script`: an end tag returns to ESCAPED.
    let state = DATA;

    for (let i = 0; i < text.length; i++) {
        if (state !== DOUBLE_ESCAPED && tagAt(text, i, '</', tn)) {
            return true;
        }

        if (tn !== $.SCRIPT) {
            continue;
        }

        if (state === DATA && text.startsWith('<!--', i)) {
            state = ESCAPED;
            // The dashes can also end the escape, as in `<!-->`.
            i++;
        } else if (state !== DATA && text.startsWith('-->', i)) {
            state = DATA;
            i += 2;
        } else if (state === ESCAPED && tagAt(text, i, '<', $.SCRIPT)) {
            state = DOUBLE_ESCAPED;
        } else if (state === DOUBLE_ESCAPED && tagAt(text, i, '</', $.SCRIPT)) {
            state = ESCAPED;
        }
    }

    return state === DOUBLE_ESCAPED;
}

/** Report whether a parser would read `<!--data-->` back as other than one comment with `data`. */
function commentEndsEarly(data: string): boolean {
    return data.startsWith('>') || data.startsWith('->') || data.includes('-->') || data.includes('--!>');
}

/** Return the text of raw text element `node`, or throw if a child is not text. */
function getRawText<T extends TreeAdapterTypeMap>(node: T['element'], { treeAdapter }: InternalOptions<T>): string {
    let text = '';

    for (const child of treeAdapter.getChildNodes(node)) {
        if (!treeAdapter.isTextNode(child)) {
            throw new MatchertextError(ERR.matchertextUnserializableText, null);
        }
        text += treeAdapter.getTextNodeContent(child);
    }

    return text;
}

/**
 * Serializes an AST node to an HTML string.
 *
 * @example
 *
 * ```js
 * import * as parse5 from 'parse5';
 *
 * const document = parse5.parse('<!DOCTYPE html><html><head></head><body>Hi there!</body></html>');
 *
 * // Serializes a document.
 * const html = parse5.serialize(document);
 *
 * // Serializes the <html> element content.
 * const htmlElement = document.childNodes.find(parse5.defaultTreeAdapter.isElementNode);
 * if (htmlElement) {
 *     const str = parse5.serialize(htmlElement);
 *     console.log(str); //> '<head></head><body>Hi there!</body>'
 * }
 * ```
 *
 * @param node Node to serialize.
 * @param options Serialization options.
 */
export function serialize<T extends TreeAdapterTypeMap = DefaultTreeAdapterMap>(
    node: T['parentNode'],
    options?: SerializerOptions<T>,
): string {
    const opts = { ...defaultOpts, ...options } as InternalOptions<T>;

    if (isVoidElement(node, opts)) {
        return '';
    }

    const { treeAdapter } = opts;
    // A template's children are those of its content fragment.
    const container =
        treeAdapter.isElementNode(node) &&
        treeAdapter.getTagName(node) === $.TEMPLATE &&
        treeAdapter.getNamespaceURI(node) === NS.HTML
            ? treeAdapter.getTemplateContent(node)
            : node;

    return serializeNodes(treeAdapter.getChildNodes(container) ?? [], opts);
}

/**
 * Serializes an AST element node to an HTML string, including the element node.
 *
 * @example
 *
 * ```js
 * import * as parse5 from 'parse5';
 *
 * const document = parse5.parseFragment('<div>Hello, <b>world</b>!</div>');
 *
 * // Serializes the <div> element.
 * const div = document.childNodes.find(parse5.defaultTreeAdapter.isElementNode);
 * if (div) {
 *     const str = parse5.serializeOuter(div);
 *     console.log(str); //> '<div>Hello, <b>world</b>!</div>'
 * }
 * ```
 *
 * @param node Node to serialize.
 * @param options Serialization options.
 */
export function serializeOuter<T extends TreeAdapterTypeMap = DefaultTreeAdapterMap>(
    node: T['node'],
    options?: SerializerOptions<T>,
): string {
    const opts = { ...defaultOpts, ...options } as InternalOptions<T>;
    return serializeNodes([node], opts);
}

function serializeNodes<T extends TreeAdapterTypeMap>(nodes: T['node'][], options: InternalOptions<T>): string {
    const { treeAdapter } = options;
    const guarded = options.matchertext || options.matchertextOutput;
    // The depth of the tree is not bounded, so the open elements (their
    // remaining siblings and end tags) are kept on explicit stacks.
    const stack: { nodes: T['node'][]; index: number; endTag: string }[] = [];
    let html = '';
    let index = 0;

    for (;;) {
        if (index < nodes.length) {
            const node = nodes[index++];

            if (treeAdapter.isElementNode(node)) {
                const tn = treeAdapter.getTagName(node);
                const isHtml = treeAdapter.getNamespaceURI(node) === NS.HTML;

                if (guarded && isHtml && hasUnescapedText(tn, options.scriptingEnabled)) {
                    const text = getRawText(node, options);

                    if (rawTextEndsEarly(tn, text)) {
                        if (!options.matchertextOutput || !verifyMatchertext(text)) {
                            throw new MatchertextError(ERR.matchertextUnserializableText, null);
                        }

                        html += `<${tn}${serializeAttributes(node, options)} [${text}]>`;
                        continue;
                    }
                }

                html += `<${tn}${serializeAttributes(node, options)}>`;

                if (guarded && isHtml && LEADING_LINE_FEED_DROPPED.has(tn)) {
                    const first = treeAdapter.getFirstChild(node);

                    if (
                        first &&
                        treeAdapter.isTextNode(first) &&
                        treeAdapter.getTextNodeContent(first).startsWith('\n')
                    ) {
                        html += '\n';
                    }
                }

                if (!(isHtml && VOID_ELEMENTS.has(tn))) {
                    stack.push({ nodes, index, endTag: `</${tn}>` });
                    nodes =
                        treeAdapter.getChildNodes(
                            isHtml && tn === $.TEMPLATE ? treeAdapter.getTemplateContent(node) : node,
                        ) ?? [];
                    index = 0;
                }
            } else if (treeAdapter.isTextNode(node)) {
                html += serializeTextNode(node, options);
            } else if (treeAdapter.isCommentNode(node)) {
                if (guarded && commentEndsEarly(treeAdapter.getCommentNodeContent(node))) {
                    throw new MatchertextError(ERR.matchertextUnserializableComment, null);
                }
                html += serializeCommentNode(node, options);
            } else if (treeAdapter.isDocumentTypeNode(node)) {
                html += serializeDocumentTypeNode(node, options);
            }
        } else {
            const parent = stack.pop();

            if (!parent) {
                return html;
            }

            html += parent.endTag;
            ({ nodes, index } = parent);
        }
    }
}

function serializeAttributes<T extends TreeAdapterTypeMap>(
    node: T['element'],
    { treeAdapter }: InternalOptions<T>,
): string {
    let html = '';
    for (const attr of treeAdapter.getAttrList(node)) {
        html += ' ';

        if (attr.namespace) {
            switch (attr.namespace) {
                case NS.XML: {
                    html += `xml:${attr.name}`;
                    break;
                }
                case NS.XMLNS: {
                    if (attr.name !== 'xmlns') {
                        html += 'xmlns:';
                    }

                    html += attr.name;
                    break;
                }
                case NS.XLINK: {
                    html += `xlink:${attr.name}`;
                    break;
                }
                default: {
                    html += `${attr.prefix}:${attr.name}`;
                }
            }
        } else {
            html += attr.name;
        }

        html += `="${escapeAttribute(attr.value)}"`;
    }

    return html;
}

function serializeTextNode<T extends TreeAdapterTypeMap>(node: T['textNode'], options: InternalOptions<T>): string {
    const { treeAdapter } = options;
    const content = treeAdapter.getTextNodeContent(node);
    const parent = treeAdapter.getParentNode(node);
    const parentTn = parent && treeAdapter.isElementNode(parent) && treeAdapter.getTagName(parent);

    return parentTn &&
        treeAdapter.getNamespaceURI(parent) === NS.HTML &&
        hasUnescapedText(parentTn, options.scriptingEnabled)
        ? content
        : escapeText(content);
}

function serializeCommentNode<T extends TreeAdapterTypeMap>(
    node: T['commentNode'],
    { treeAdapter }: InternalOptions<T>,
): string {
    return `<!--${treeAdapter.getCommentNodeContent(node)}-->`;
}

function serializeDocumentTypeNode<T extends TreeAdapterTypeMap>(
    node: T['documentType'],
    { treeAdapter }: InternalOptions<T>,
): string {
    return `<!DOCTYPE ${treeAdapter.getDocumentTypeNodeName(node)}>`;
}
