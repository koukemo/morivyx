export function packageRecords(packageContents) {
  const records = [];
  for (const key of ["elements", "approvals", "changeSets", "migrations"]) {
    if (Array.isArray(packageContents[key])) {
      records.push(...packageContents[key]);
    }
  }
  if (Array.isArray(packageContents.reports)) {
    records.push(
      ...packageContents.reports.map((entry) => entry?.report ?? entry),
    );
  }
  return records;
}
