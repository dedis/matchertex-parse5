import { ErrorCodes, MatchertextError, TokenizerMode, verifyMatchertext, type Token } from 'parse5';
import {
    SAXParser,
    type SAXParserOptions,
    type EndTag,
    type StartTag,
    type Doctype,
    type Text,
    type Comment,
    type SaxToken,
} from 'parse5-sax-parser';
import { escapeText, escapeAttribute } from 'entities/escape';

/**
 * Streaming [SAX](https://en.wikipedia.org/wiki/Simple_API_for_XML)-style HTML rewriter.
 * A [transform stream](https://nodejs.org/api/stream.html#stream_class_stream_transform) (which means you can pipe _through_ it, see example).
 *
 * The rewriter uses the raw source representation of tokens if they are not modified by the user. Therefore, the resulting
 * HTML is not affected by parser error-recovery mechanisms as in a classical parsing-serialization roundtrip.
 *
 * @example
 *
 * ```js
 * const RewritingStream = require('parse5-html-rewriting-stream');
 * const http = require('http');
 * const fs = require('fs');
 *
 * const file = fs.createWriteStream('/home/google.com.html');
 * const rewriter = new RewritingStream();
 *
 * // Replace divs with spans
 * rewriter.on('startTag', startTag => {
 *     if (startTag.tagName === 'span') {
 *         startTag.tagName = 'div';
 *     }
 *
 *     rewriter.emitStartTag(startTag);
 * });
 *
 * rewriter.on('endTag', endTag => {
 *     if (endTag.tagName === 'span') {
 *         endTag.tagName = 'div';
 *     }
 *
 *     rewriter.emitEndTag(endTag);
 * });
 *
 * // Wrap all text nodes with an <i> tag
 * rewriter.on('text', (_, raw) => {
 *     // Use the raw representation of text without HTML entities decoding
 *     rewriter.emitRaw(`<i>${raw}</i>`);
 * });
 *
 * http.get('http://google.com', res => {
 *    // Assumes response is UTF-8.
 *    res.setEncoding('utf8');
 *    // `RewritingStream` is a `Transform` stream, which means you can pipe
 *    // through it.
 *    res.pipe(rewriter).pipe(file);
 * });
 * ```
 */
export class RewritingStream extends SAXParser {
    /** Whether text is currently tokenized without decoding character references. */
    private inRawText = false;
    /** Whether the input is in the content of a matchertext element. */
    private inInputHole = false;
    /** Whether the output is in the content of a matchertext element, which only matchertext can be written to. */
    private inOutputHole = false;

    /**
     * Note: `sourceCodeLocationInfo` is always enabled.
     *
     * @param options With `matchertext`, the input can use the matchertext syntax. Everything written into the
     * content of a matchertext element of the output must then be matchertext, or the stream fails with a
     * `MatchertextError`. The text of a matchertext element whose start tag is not written is escaped.
     */
    constructor(options: Pick<SAXParserOptions, 'matchertext'> = {}) {
        super({ ...options, sourceCodeLocationInfo: true });
    }

    override _transformChunk(chunk: string): string {
        // NOTE: ignore upstream return values as we want to push to
        // the `Writable` part of the `Transform` stream ourselves.
        super._transformChunk(chunk);
        return '';
    }

    private _getRawHtml(location: Token.Location): string {
        const { droppedBufferSize, html } = this.tokenizer.preprocessor;
        const start = location.startOffset - droppedBufferSize;
        const end = location.endOffset - droppedBufferSize;

        return html.slice(start, end);
    }

    // Events
    protected override emitIfListenerExists(eventName: string, token: SaxToken): boolean {
        if (eventName === 'startTag') {
            // The tokenizer has already been switched to the state for this element's content. Matchertext content
            // is not raw text: it is written in a matchertext element or escaped.
            const { state } = this.tokenizer;
            this.inRawText =
                !(token as StartTag).matchertext &&
                (state === TokenizerMode.RAWTEXT ||
                    state === TokenizerMode.SCRIPT_DATA ||
                    state === TokenizerMode.PLAINTEXT);
        }

        if (!super.emitIfListenerExists(eventName, token)) {
            this._emitUnchanged(eventName, token);
        }

        if (eventName === 'startTag' && (token as StartTag).matchertext) {
            this.inInputHole = true;
        } else if (eventName === 'endTag') {
            this.inRawText = false;
            this.inInputHole = false;
        }

        // NOTE: don't skip new lines after `<pre>` and other tags,
        // otherwise we'll have incorrect raw data.
        this.parserFeedbackSimulator.skipNextNewLine = false;
        return true;
    }

    /** Write a token that no listener handles, as its source if the output context allows it. */
    private _emitUnchanged(eventName: string, token: SaxToken): void {
        const raw = this._getRawHtml(token.sourceCodeLocation!);

        if (eventName === 'endTag' && (token as EndTag).matchertext) {
            this.emitEndTag(token as EndTag);
        } else if (eventName === 'text' && this.inInputHole && !this.inOutputHole) {
            this.emitText(token as Text);
        } else {
            this._writeOutput(raw);
            this.inOutputHole ||= eventName === 'startTag' && (token as StartTag).matchertext === true;
        }
    }

    /** Write `html`, which must be matchertext in the content of a matchertext element of the output. */
    private _writeOutput(html: string): void {
        if (this.inOutputHole && !verifyMatchertext(html)) {
            throw new MatchertextError(ErrorCodes.matchertextInvalidArgument, null);
        }

        this.push(html);
    }

    // Emitter API
    protected override _emitToken(eventName: string, token: SaxToken): void {
        this.emit(eventName, token, this._getRawHtml(token.sourceCodeLocation!));
    }

    /** Emits a serialized document type token into the output stream. */
    public emitDoctype(token: Doctype): void {
        let res = `<!DOCTYPE ${token.name}`;

        if (token.publicId !== null) {
            res += ` PUBLIC "${token.publicId}"`;
        } else if (token.systemId !== null) {
            res += ' SYSTEM';
        }

        if (token.systemId !== null) {
            res += ` "${token.systemId}"`;
        }

        res += '>';

        this._writeOutput(res);
    }

    /**
     * Emits a serialized start tag token into the output stream. A matchertext start tag opens the content of a
     * matchertext element, as `<tag attrs [`.
     */
    public emitStartTag(token: StartTag): void {
        let res = `<${token.tagName}`;

        for (const attr of token.attrs) {
            res += ` ${attr.name}="${escapeAttribute(attr.value)}"`;
        }

        if (token.matchertext) {
            this._writeOutput(`${res} [`);
            this.inOutputHole = true;
        } else {
            this._writeOutput(res + (token.selfClosing ? '/>' : '>'));
        }
    }

    /**
     * Emits a serialized end tag token into the output stream. A matchertext end tag closes the open matchertext
     * element as `]>`.
     */
    public emitEndTag(token: EndTag): void {
        if (token.matchertext && this.inOutputHole) {
            this.push(']>');
            this.inOutputHole = false;
        } else {
            this._writeOutput(`</${token.tagName}>`);
        }
    }

    /**
     * Emits a serialized text token into the output stream. In a matchertext element the text is written as it is
     * and must be matchertext.
     */
    public emitText({ text }: Text): void {
        this._writeOutput(this.inOutputHole || this.inRawText ? text : escapeText(text));
    }

    /** Emits a serialized comment token into the output stream. */
    public emitComment(token: Comment): void {
        this._writeOutput(`<!--${token.text}-->`);
    }

    /** Emits a raw HTML string into the output stream. In a matchertext element it must be matchertext. */
    public emitRaw(html: string): void {
        this._writeOutput(html);
    }
}

export interface RewritingStream {
    /** Raised when the rewriter encounters a start tag. */
    on(event: 'startTag', listener: (startTag: StartTag, rawHtml: string) => void): this;
    /** Raised when rewriter encounters an end tag. */
    on(event: 'endTag', listener: (endTag: EndTag, rawHtml: string) => void): this;
    /** Raised when rewriter encounters a comment. */
    on(event: 'comment', listener: (comment: Comment, rawHtml: string) => void): this;
    /** Raised when rewriter encounters text content. */
    on(event: 'text', listener: (text: Text, rawHtml: string) => void): this;
    /** Raised when rewriter encounters a [document type declaration](https://en.wikipedia.org/wiki/Document_type_declaration). */
    on(event: 'doctype', listener: (doctype: Doctype, rawHtml: string) => void): this;

    /**
     * Base event handler.
     *
     * @param event Name of the event
     * @param handler Event handler
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, handler: (...args: any[]) => void): this;
}
