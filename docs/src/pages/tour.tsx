import Layout from "@theme/Layout";
import Tour from "../components/Tour";
import tour from "../tours/framework-tour";
import styles from "./tour.module.css";

/** The framework tour, on its own page: the stage takes the whole width. */
export default function TourPage() {
  return (
    <Layout title="Framework tour" description="An animated tour of every Act capability, shown as what it does to the event store.">
      <main className={styles.page}>
        <h1 className={styles.hidden}>Framework tour</h1>
        <Tour spec={tour} />
      </main>
    </Layout>
  );
}
