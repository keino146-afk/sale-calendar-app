import { DOMParser, type Document, type Element } from "@xmldom/xmldom";

// Strict, bounded reader for RSS 2.0 and RSS 1.0 (RDF) feeds, the formats the
// collector's sources publish. It turns a feed into raw items and
// decides nothing about sales: classification and dates belong to each
// source adapter. Text is returned as plain strings and never interpreted as
// HTML. Anything unexpected throws, which the pipeline reports as a parse
// failure; a feed is never truncated and read partially.

export const RSS_MAX_BYTES = 2 * 1024 * 1024;
export const RSS_MAX_ITEMS = 500;

export type RawRssItem = {
  title: string | null;
  link: string | null;
  guid: string | null;
  publishedAt: Date | null;
  description: string | null;
};

export class RssParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RssParseError";
  }
}

// DOCTYPE and entity declarations are refused outright: nothing is ever
// expanded or resolved, internal or external.
const DECLARATION = /<!\s*(DOCTYPE|ENTITY)/i;

// RSS 1.0 elements are matched by namespace, not by prefix.
const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RSS1_NS = "http://purl.org/rss/1.0/";
const DC_NS = "http://purl.org/dc/elements/1.1/";

function isElement(node: { nodeType: number }): node is Element {
  return node.nodeType === 1;
}

// RSS 2.0 names have no namespace; RSS 1.0 names are namespaced.
type Name = string | { ns: string; local: string };

function matches(element: Element, name: Name): boolean {
  return typeof name === "string"
    ? element.tagName === name
    : element.namespaceURI === name.ns && element.localName === name.local;
}

function childElements(parent: Element, name: Name): Element[] {
  const found: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (isElement(node) && matches(node, name)) found.push(node);
  }
  return found;
}

// Text of the single child element with this name; null when missing,
// repeated (ambiguous) or blank.
function childText(item: Element, name: Name): string | null {
  const elements = childElements(item, name);
  if (elements.length !== 1) return null;
  const text = (elements[0].textContent ?? "").trim();
  return text === "" ? null : text;
}

function parseDate(value: string | null): Date | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

export function parseRssItems(body: string): RawRssItem[] {
  if (Buffer.byteLength(body, "utf8") > RSS_MAX_BYTES) throw new RssParseError("feed too large");
  if (DECLARATION.test(body)) throw new RssParseError("DOCTYPE or ENTITY declarations are not accepted");

  let document: Document;
  try {
    document = new DOMParser({
      // Every warning or error stops parsing: malformed XML is never repaired.
      onError: (level) => {
        throw new RssParseError(`xml ${level}`);
      },
    }).parseFromString(body, "text/xml");
  } catch {
    throw new RssParseError("invalid xml");
  }

  const root = document.documentElement;
  if (root !== null && root.tagName === "rss") return readRss2(root);
  if (root !== null && matches(root, { ns: RDF_NS, local: "RDF" })) return readRss1(root);
  throw new RssParseError("not an rss document");
}

function limitItems(items: Element[]): Element[] {
  if (items.length > RSS_MAX_ITEMS) throw new RssParseError("too many items");
  return items;
}

// RSS 2.0: <rss><channel><item>...</item></channel></rss>
function readRss2(root: Element): RawRssItem[] {
  const channels = childElements(root, "channel");
  if (channels.length !== 1) throw new RssParseError("expected exactly one channel");

  return limitItems(childElements(channels[0], "item")).map((item) => ({
    title: childText(item, "title"),
    link: childText(item, "link"),
    guid: childText(item, "guid"),
    publishedAt: parseDate(childText(item, "pubDate")),
    description: childText(item, "description"),
  }));
}

// RSS 1.0: <rdf:RDF><channel/><item rdf:about="...">...</item></rdf:RDF>,
// items beside the channel and the date in dc:date.
function readRss1(root: Element): RawRssItem[] {
  const channels = childElements(root, { ns: RSS1_NS, local: "channel" });
  if (channels.length !== 1) throw new RssParseError("expected exactly one channel");

  return limitItems(childElements(root, { ns: RSS1_NS, local: "item" })).map((item) => ({
    title: childText(item, { ns: RSS1_NS, local: "title" }),
    link: childText(item, { ns: RSS1_NS, local: "link" }),
    guid: item.getAttributeNS(RDF_NS, "about") || null,
    publishedAt: parseDate(childText(item, { ns: DC_NS, local: "date" })),
    description: childText(item, { ns: RSS1_NS, local: "description" }),
  }));
}
