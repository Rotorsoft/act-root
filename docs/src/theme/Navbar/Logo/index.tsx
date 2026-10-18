import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import ThemedImage from "@theme/ThemedImage";
import type { JSX } from "react";

// The navbar brand: the cat logo plus the Act wordmark in its three colors
// (A cyan, c amber, t green), with the "t" swinging now and then (custom.css).
export default function NavbarLogo(): JSX.Element {
  return (
    <Link to="/" className="navbar__brand act-brand" aria-label="Act home">
      <ThemedImage
        className="navbar__logo"
        alt=""
        sources={{ light: useBaseUrl("/img/logo.png"), dark: useBaseUrl("/img/logo-dark.png") }}
      />
      <span className="act-wordmark" aria-hidden="true">
        <span className="act-a">A</span>
        <span className="act-c">c</span>
        <span className="act-t">t</span>
      </span>
    </Link>
  );
}
