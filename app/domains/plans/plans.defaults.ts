export const planDefaults = [
  {
    key: "semester-round",
    name: "plans.defaults.semester.name",
    basis: "plans.defaults.semester.basis",
    sourceUrl: "https://publikationen.dguv.de/widgets/pdf/download/article/787",
    workType: "round",
    target: "rooms",
    semester: true,
    intervalMonths: null,
  },
  {
    key: "portable-electrical",
    name: "plans.defaults.electrical.name",
    basis: "plans.defaults.electrical.basis",
    sourceUrl: "https://www.bgbau-medien.de/handlungshilfen_gb/daten/dguv/3/5.htm#d5A1N2",
    workType: "inspection",
    target: "portable",
    semester: false,
    intervalMonths: 6,
  },
] as const;

export const inspectionStandard =
  "https://www.dke.de/de/normen-standards/dokument?id=7156902&type=dke%7Cdokument";
