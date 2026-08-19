/**
 * data.gov.sg dataset IDs for ACRA's open registers.
 *
 * Two collections, and they are NOT interchangeable:
 *
 *   Collection 1 "Registered Entities with UEN" — one row per UEN, queryable
 *     by UEN directly. Cheap: a single exact-filter call. Gives entity name,
 *     status, type, street name and postal code.
 *
 *   Collection 2 "ACRA Information on Corporate Entities" — the rich record
 *     (incorporation date, SSIC, officers, and the FULL address including
 *     block, building and unit). Split into 27 CSVs keyed by the FIRST LETTER
 *     OF THE ENTITY NAME, so it cannot be queried by UEN at all. You must
 *     learn the name from collection 1 first, then pick the letter dataset.
 *
 * The full address only exists in collection 2, and Wise's `singapore_paynow`
 * payout requires a full address, so the second call is load-bearing for the
 * micro-deposit rather than a nicety. See docs/wise-paynow-probe.md.
 *
 * Refreshed monthly. A company registered in the last few weeks is legitimately
 * absent, which is why "not found" must never reject an onboarding.
 */

export const DATAGOV_BASE = "https://data.gov.sg/api/action/datastore_search";

/** Collection 1, ACRA-issued UENs (businesses and companies). */
export const UEN_DATASET_ACRA = "d_3f960c10fed6145404ca7b821f263b87";

/**
 * Collection 1, UENs issued by other agencies (ROS, SLA, MOE, MUIS, ...).
 * Societies and similar. Not the merchant population, but a UEN found only
 * here is real — it just is not an ACRA business.
 */
export const UEN_DATASET_OTHER = "d_b1d2b840ab9e993570c037b706b39bb8";

/**
 * Collection 2, keyed by the first letter of the entity name. `OTHERS` holds
 * names starting with a digit or symbol.
 */
export const DETAIL_DATASETS: Record<string, string> = {
  A: "d_8575e84912df3c28995b8e6e0e05205a",
  B: "d_3a3807c023c61ddfba947dc069eb53f2",
  C: "d_c0650f23e94c42e7a20921f4c5b75c24",
  D: "d_acbc938ec77af18f94cecc4a7c9ec720",
  E: "d_124a9bd407c7a25f8335b93b86e50fdd",
  F: "d_4526d47d6714d3b052eed4a30b8b1ed6",
  G: "d_b58303c68e9cf0d2ae93b73ffdbfbfa1",
  H: "d_fa2ed456cf2b8597bb7e064b08fc3c7c",
  I: "d_85518d970b8178975850457f60f1e738",
  J: "d_478f45a9c541cbe679ca55d1cd2b970b",
  K: "d_5573b0db0575db32190a2ad27919a7aa",
  L: "d_a2141adf93ec2a3c2ec2837b78d6d46e",
  M: "d_9af9317c646a1c881bb5591c91817cc6",
  N: "d_67e99e6eabc4aad9b5d48663b579746a",
  O: "d_5c4ef48b025fdfbc80056401f06e3df9",
  P: "d_181005ca270b45408b4cdfc954980ca2",
  Q: "d_4130f1d9d365d9f1633536e959f62bb7",
  R: "d_2b8c54b2a490d2fa36b925289e5d9572",
  S: "d_df7d2d661c0c11a7c367c9ee4bf896c1",
  T: "d_72f37e5c5d192951ddc5513c2b134482",
  U: "d_0cc5f52a1f298b916f317800251057f3",
  V: "d_e97e8e7fc55b85a38babf66b0fa46b73",
  W: "d_af2042c77ffaf0db5d75561ce9ef5688",
  X: "d_1cd970d8351b42be4a308d628a6dd9d3",
  Y: "d_31af23fdb79119ed185c256f03cb5773",
  Z: "d_4e3db8955fdcda6f9944097bef3d2724",
  OTHERS: "d_300ddc8da4e8f7bdc1bfc62d0d99e2e7",
};

/**
 * Which letter dataset holds this entity name. ACRA files by the raw first
 * character of the registered name, so normalization must NOT be applied here:
 * "THE COFFEE BEAN" lives under T, not C.
 */
export function detailDatasetFor(entityName: string): string {
  const first = entityName.trim().charAt(0).toUpperCase();
  return DETAIL_DATASETS[first] ?? DETAIL_DATASETS.OTHERS;
}
