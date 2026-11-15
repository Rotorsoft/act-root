import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import Tour from "../components/Tour";
import tour from "../tours/framework-tour";
import styles from "./tour.module.css";

/** The framework tour, on its own page: the whole width goes to the stage and the log. */
export default function TourPage() {
  return (
    <Layout
      title="Framework tour"
      description="An animated tour of every Act capability, shown as what it does to the event store."
    >
      <main className={styles.page}>
        <header className={styles.intro}>
          <h1>Framework tour</h1>
          <p>
            Every capability of Act, from a first action to closing the books, shown as what it does to the{" "}
            <b>event store</b>: one ordered log that every stream shares. Pick a chapter, then press <b>Play</b> or
            step with the arrow keys. Each scene links the page that explains it and the test that proves it. The
            storyboard is{" "}
            <Link href="https://github.com/Rotorsoft/act-root/blob/master/docs/flows/framework-tour.script.md">
              framework-tour.script.md
            </Link>
            ; for one app's flows instead, see <Link to="/docs/guides/flow-animations">flow animations</Link>.
          </p>
        </header>
        <Tour spec={tour} />
      </main>
    </Layout>
  );
}
