declare module "*.css";

declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    "s-page": any;
    "s-section": any;
    "s-button": any;
    "s-link": any;
    "s-paragraph": any;
    "s-text": any;
    "s-heading": any;
    "s-stack": any;
    "s-box": any;
    "s-banner": any;
    "s-badge": any;
    "s-table": any;
    "s-table-header-row": any;
    "s-table-header": any;
    "s-table-body": any;
    "s-table-row": any;
    "s-table-cell": any;
    "s-text-field": any;
    "s-unordered-list": any;
    "s-list-item": any;
  }
}
