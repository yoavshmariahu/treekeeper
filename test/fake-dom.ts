/**
 * A DOM small enough to read and big enough to run the dashboard's inline
 * script: elements, text nodes, attributes, classes and events, and nothing
 * that can turn a string into markup.
 *
 * That last part is the point. There is no HTML parser behind any node here:
 * `innerHTML`, `outerHTML` and `insertAdjacentHTML` all throw, so a script that
 * reached for one to render a branch name would fail the test rather than
 * quietly ship an injection.
 */

export class FakeNode {
  parentNode: FakeElement | null = null;
}

export class FakeText extends FakeNode {
  constructor(public nodeValue: string) {
    super();
  }
  get textContent(): string {
    return this.nodeValue;
  }
  set textContent(value: string) {
    this.nodeValue = value;
  }
}

const VOID_HTML = new Set(["link", "meta", "br", "img", "input", "hr"]);

export class FakeElement extends FakeNode {
  readonly childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  readonly style: Record<string, string> = {};
  hidden = false;
  disabled = false;

  constructor(
    readonly tagName: string,
    readonly namespace: "html" | "svg" = "html",
    private readonly doc?: FakeDocument,
  ) {
    super();
  }

  // The sinks that would turn a string into markup. None of them exist here.
  set innerHTML(_v: unknown) {
    throw new Error(`<${this.tagName}>.innerHTML was assigned: markup built from a string`);
  }
  set outerHTML(_v: unknown) {
    throw new Error(`<${this.tagName}>.outerHTML was assigned: markup built from a string`);
  }
  insertAdjacentHTML(): never {
    throw new Error(`<${this.tagName}>.insertAdjacentHTML: markup built from a string`);
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }
  set className(value: string) {
    this.attributes.set("class", value);
  }

  get classList() {
    const classes = (): string[] => this.className.split(" ").filter(Boolean);
    const write = (list: string[]): void => {
      this.className = list.join(" ");
    };
    return {
      add: (c: string) => {
        if (!classes().includes(c)) write([...classes(), c]);
      },
      remove: (c: string) => write(classes().filter((x) => x !== c)),
      contains: (c: string) => classes().includes(c),
      toggle: (c: string, on?: boolean) => {
        const want = on === undefined ? !classes().includes(c) : on;
        if (want) {
          if (!classes().includes(c)) write([...classes(), c]);
        } else write(classes().filter((x) => x !== c));
      },
    };
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  get textContent(): string {
    return this.childNodes
      .map((n) => (n instanceof FakeText ? n.nodeValue : (n as FakeElement).textContent))
      .join("");
  }
  set textContent(value: string) {
    this.childNodes.length = 0;
    if (value !== "") this.appendChild(new FakeText(value));
  }

  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode = this;
    this.childNodes.push(node);
    if (node instanceof FakeElement) this.doc?.index(node);
    return node;
  }

  removeChild<T extends FakeNode>(node: T): T {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === "id") this.doc?.index(this);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** Fire a listener the way a browser would when someone clicks or tabs in. */
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type });
  }

  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) {
          out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  /** The tree as HTML, with text and attribute values escaped as a browser would. */
  serialize(): string {
    const attrs = [...this.attributes.entries()]
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
      .join("");
    const open = `<${this.tagName}${attrs}>`;
    if (VOID_HTML.has(this.tagName) && this.namespace === "html") return open;
    const inner = this.childNodes
      .map((n) => (n instanceof FakeText ? escapeHtml(n.nodeValue) : (n as FakeElement).serialize()))
      .join("");
    return `${open}${inner}</${this.tagName}>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class FakeDocument {
  readonly root: FakeElement;
  readonly byId = new Map<string, FakeElement>();
  visibilityState = "visible";
  readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(bodyHtml: string) {
    this.root = new FakeElement("body", "html", this);
    parseInto(this.root, bodyHtml, this);
  }

  index(node: FakeElement): void {
    const id = node.getAttribute("id");
    if (id) this.byId.set(id, node);
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toLowerCase(), "html", this);
  }

  createElementNS(ns: string, tag: string): FakeElement {
    if (ns !== "http://www.w3.org/2000/svg") throw new Error(`unexpected namespace ${ns}`);
    return new FakeElement(tag, "svg", this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  /** Only the selectors the page uses: `.class` and `#id`. */
  querySelectorAll(selector: string): FakeElement[] {
    if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      return this.root.descendants().filter((n) => n.classList.contains(cls));
    }
    if (selector.startsWith("#")) {
      const hit = this.getElementById(selector.slice(1));
      return hit ? [hit] : [];
    }
    throw new Error(`unsupported selector ${selector}`);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type });
  }

  text(): string {
    return this.root.textContent;
  }
}

/** Enough of an HTML parser for the page's own static body: tags, attributes, text. */
function parseInto(parent: FakeElement, html: string, doc: FakeDocument): void {
  const stack: FakeElement[] = [parent];
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"]|"[^"]*")*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    const [, closing, tag, rawAttrs, text] = m;
    const top = stack[stack.length - 1]!;
    if (text !== undefined) {
      if (text.trim() !== "") top.appendChild(new FakeText(text.trim()));
      continue;
    }
    const name = tag!.toLowerCase();
    if (closing === "/") {
      if (top.tagName !== name) throw new Error(`mismatched </${name}> inside <${top.tagName}>`);
      stack.pop();
      continue;
    }
    const node = new FakeElement(name, "html", doc);
    const attr = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let a: RegExpExecArray | null;
    while ((a = attr.exec(rawAttrs ?? "")) !== null) {
      if (a[1] === "hidden" && a[2] === undefined) node.hidden = true;
      else node.setAttribute(a[1]!, a[2] ?? "");
    }
    top.appendChild(node);
    if (!VOID_HTML.has(name)) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1]!.tagName}>`);
}
