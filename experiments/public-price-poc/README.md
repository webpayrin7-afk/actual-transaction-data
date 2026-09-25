# Public Price PoC — Phase 1.4B

Official MOLIT housing public-price bulk (dataset **3073746**) pilot for ZIPLAB.

## Verified layout (2025 package)

- Encoding: UTF-8 (utf-8-sig accepted)
- Row separator: CRLF
- Column separator: `,`
- Quoting: fields wrapped in double quotes
- Header row: yes

Actual columns (not estimated):

1. 기준연도
2. 기준월
3. 법정동코드
4. 도로명주소
5. 시도
6. 시군구
7. 읍면
8. 동리
9. 특수지코드
10. 본번
11. 부번
12. 특수지명
13. 단지명
14. 동명
15. 호명
16. 전용면적
17. 공시가격
18. 단지코드
19. 동코드
20. 호코드
21. 건축물대장PK

See `layout-columns.json`.

Building register field is **`건축물대장PK`** (세움터 BLDRGST_SEQNO).  
It is **not** `관리건축물대장PK`.

## Building register PK audit

| Check | Result |
| --- | --- |
| Field present | yes (`건축물대장PK`) |
| Official sample (99,999 rows) nulls | 791 |
| Official sample non-null unique | yes |
| 잠실엘스 full extract (5,678 rows) nulls | 0 |
| 잠실엘스 non-null unique | yes |
| Classification | **NULLABLE** |
| Safe as sole unique key | **no** |

Keep as linkage metadata only. Pilot identity = source + complex_id + year + normalized dong/ho + exclusive_area.

## Pilot unit (UNIT_EXACT)

- complex_id: `cx_4c63d9a100973c60`
- name: 잠실엘스
- road: 서울특별시 송파구 올림픽로 99
- lot: 서울특별시 송파구 잠실동 19
- year/date: 2025 / 2025-01-01
- dong/ho: 131 / 101
- exclusive area: 84.97㎡
- official price: 1,716,000,000원
- building_register_pk: `10251100214253`

Extracted from official bulk CSV (stream filter). No production scraping. No nationwide DB ingest.

## Safety

- No Seoul/Gyeonggi/nationwide ingest
- DB writes: 0
- Management-fee UI: untouched
- Tax formulas: untouched
