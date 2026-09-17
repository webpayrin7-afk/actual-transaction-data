/**
 * One-shot SchoolInfo detail verification (no secrets printed).
 * Usage: npx tsx scripts/verify-schoolinfo-detail.ts
 */
import { getSchoolDetail } from "../src/lib/school-info/get-school-detail";
import { findKnownLink } from "../src/lib/school-info/identity";
import type { Kind } from "../src/lib/school-info/identity";

type Sample = {
  code: string;
  label: string;
  name: string;
  kind: Kind;
};

const samples: Sample[] = [
  {
    code: "7130153",
    label: "elementary",
    name: "서울잠일초등학교",
    kind: "elementary",
  },
  {
    code: "7130202",
    label: "middle",
    name: "잠실중학교",
    kind: "middle",
  },
  {
    code: "7010107",
    label: "high",
    name: "잠실고등학교",
    kind: "high",
  },
];

async function main() {
  const keyPresent = Boolean(process.env.SCHOOLINFO_API_KEY?.trim());
  console.log(JSON.stringify({ envDetected: keyPresent ? "YES" : "NO" }));
  if (!keyPresent) {
    process.exitCode = 1;
    return;
  }

  for (const s of samples) {
    const link = findKnownLink(s.code);
    const d = await getSchoolDetail({
      schoolCode: s.code,
      nameHint: s.name,
      kind: s.kind,
    });
    console.log(
      JSON.stringify(
        {
          label: s.label,
          routeNeis: s.code,
          knownLink: link?.schoolInfoSchulCode ?? null,
          resolvedSchoolInfo: d.schoolInfoCode,
          mapping: d.mapping,
          sameCode: d.sameCode,
          name: d.name,
          kind: d.kind,
          foundation: d.foundation,
          coedu: d.coedu,
          address: d.address,
          sectionStatus: d.sectionStatus,
          core: {
            students: d.core.students?.value ?? null,
            classes: d.core.classes?.value ?? null,
            classSize: d.core.classSize?.value ?? null,
            teachers: d.core.teachers?.value ?? null,
            spt: d.core.studentsPerTeacher?.value ?? null,
          },
          meal: d.schoolLife.mealPerStudent?.value ?? null,
          afterSchool: d.schoolLife.afterSchoolPrograms?.value ?? null,
          scholarship: d.scholarship?.total?.value ?? null,
          advancement: d.advancement,
          advancementStatus: d.sectionStatus.advancement,
          auth: d.auth,
          attribution: d.attribution,
        },
        null,
        2,
      ),
    );
  }

  const bad = await getSchoolDetail({
    schoolCode: "9999999",
    nameHint: "없는학교",
    kind: "middle",
  });
  console.log(
    JSON.stringify({
      label: "invalid",
      mapping: bad.mapping,
      schoolInfoCode: bad.schoolInfoCode,
      name: bad.name,
      auth: bad.auth,
      sectionStatus: bad.sectionStatus,
    }),
  );
}

main().catch((err) => {
  console.error("VERIFY_FAILED", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
