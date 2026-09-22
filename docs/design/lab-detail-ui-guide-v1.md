# LAB Series Detail UI Guide v1

단지상세가 기준 페이지다. 지역현황, 학교상세, 경매상세도 이 계층을 재사용한다.

스타일 원본은 `src/app/globals.css`의 `.detail-*`다. 클래스 이름은 `src/components/ui/detail-ui.ts`.

## Typography

| Role | Class | Size | Weight | Use |
| --- | --- | --- | --- | --- |
| Page title | `detail-page-title` | 26px, desktop 30px | 700 | 단지명만 |
| Section title | `detail-section-title` | 18px | 650 | 시세 추이, 지역 내 비교, 주변 생활 |
| Subsection title | `detail-subsection-title` | 16px | 650 | 집랩 순위, 가격 비교, 지하철 |
| Body | `detail-body` | 14px | 450 | 설명, 빈 상태 |
| Label | `detail-label` | 14px | 500 | 종합, 30평대, 용적률 |
| Meta | `detail-meta` | 13px | 500 | 기준일, 출처, 평형대 |
| Caption | `detail-caption` | 12px | 400 | 축 라벨, 아주 보조적인 문구 |
| Number | `detail-number` | 16px | 650 | 순위, 가격 숫자 |
| Number strong | `detail-number-strong` | 18px | 700 | 카드 안 대표 숫자 하나 |
| Unit | `detail-number-unit` | 12px | 500 | 만원/평, 위, 개 |

숫자와 단위를 한 덩어리로 같은 굵기에 두지 않는다.

## Spacing

| Token | Class | Size |
| --- | --- | --- |
| Section gap | `detail-page` | 32px, desktop 40px |
| Title → content | `detail-after-title` | 16px |
| Subsection | `detail-subsection` | 24px |
| Subsection with one rule | `detail-subsection-rule` | 12px + rule + 12px |
| Card padding | `detail-card` | 16px, desktop 20px |
| Row gap | `detail-rows` | 12px |
| Tab → chart | `detail-chart-gap` | 12px |
| Separated CTA | `detail-cta` | 24px |

같은 depth의 카드는 `lab-card detail-card`만 쓴다. 카드마다 12/16/24px padding을 섞지 않는다.

## Components

- Tabs: 14px. 기본 weight 500, 선택 weight 650. 선택해도 크기는 같다. 단지상세는 `.detail-page .lab-tab-secondary`.
- Chips: `detail-chip` (12px, weight 600). 제목이나 숫자보다 강하면 안 된다.
- Meta는 본문 오른쪽에 두되 `detail-meta`보다 커지지 않는다.
- Divider는 간격으로 부족할 때만 하나. `detail-subsection-rule`.
- 같은 레벨 카드의 border, radius, surface는 `lab-card` 하나.

## Do / Don't

Do

- 단지명을 페이지에서 가장 크게 둔다.
- 섹션 제목은 전부 `detail-section-title`.
- 순위·가격은 숫자와 단위를 나눈다.
- 기준일, 출처, 단위는 meta 또는 caption.

Don't

- `text-[15px]`, `text-[17px]`, `mt-[18px]` 같은 일회성 크기를 단지상세에 추가하지 않는다.
- 섹션마다 제목 크기나 카드 padding을 다르게 두지 않는다.
- 기준일이나 출처를 semibold 14px 이상으로 올리지 않는다.
- 카드 안에 divider를 반복하지 않는다.
- 선택 탭만 글자를 키우지 않는다.
