declare namespace JSX {
  interface IntrinsicElements {
    [tag: string]: any;
  }
  interface Element {}
  interface ElementChildrenAttribute {
    children: {};
  }
}
