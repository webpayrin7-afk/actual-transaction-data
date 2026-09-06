# 평촌 신도시 아파트 실거래가 대시보드

안양시 동안구(법정동코드 `41173`) 아파트 **매매·전월세** 실거래가를 조회하는 Next.js 웹 애플리케이션입니다.

## 프로젝트 구조

```text
├── .env.local.example          # API Key 예시
├── package.json
├── src/
│   ├── app/
│   │   ├── api/transactions/route.ts   # 실거래 조회 API Route
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── providers.tsx               # TanStack Query Provider
│   ├── components/
│   │   ├── Dashboard.tsx               # 메인 화면
│   │   ├── FilterBar.tsx               # 단지명/동/유형/면적/년월 필터
│   │   ├── StatsCards.tsx              # 통계 카드
│   │   ├── TransactionTable.tsx        # 거래 테이블
│   │   └── Pagination.tsx
│   ├── hooks/
│   │   └── useTransactions.ts
│   ├── lib/
│   │   ├── constants/regions.ts        # 동안구 동 목록·API URL
│   │   ├── molit/
│   │   │   ├── client.ts               # 국토부 API 요청
│   │   │   ├── parse.ts                # XML 파싱·필터·정렬
│   │   │   └── service.ts              # 조회/통계/페이지네이션
│   │   ├── mock/sample-data.ts         # API Key 없을 때 데모 데이터
│   │   └── utils/format.ts             # 억 원·평형 변환 등
│   └── types/transaction.ts
```

## 1. 패키지 설치

```bash
npm install
```

주요 의존성:

- `next`, `react`, `react-dom`
- `tailwindcss`
- `@tanstack/react-query`
- `lucide-react`
- `fast-xml-parser`

## 2. 환경변수 설정

`.env.local.example`을 복사해 `.env.local`을 만듭니다.

```bash
cp .env.local.example .env.local
```

```env
MOLIT_API_KEY=여기에_발급받은_서비스키_입력
```

- 공공데이터포털에서 **국토교통부_아파트매매 실거래가 상세 자료** API 활용 신청
- (전월세) **국토교통부_아파트 전월세 실거래가** API도 동일 키로 사용 가능
- `MOLIT_API_KEY`가 없거나 API 호출이 실패하면 **샘플(목) 데이터**로 UI를 확인할 수 있습니다

## 3. 실행

```bash
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 접속

```bash
npm run build && npm start   # 프로덕션
```

## 기능

| 기능 | 설명 |
|------|------|
| 지역 | 안양시 동안구 (평촌동, 관양동, 비산동, 호계동 등) |
| 필터 | 단지명 검색, 동, 매매/전월세, 전용면적, 계약년월 |
| 테이블 | 계약일자, 단지명, 법정동, 면적(㎡·평), 금액(억), 층 |
| 통계 | 총 건수, 오늘/최근 7일, 최고가 매매 단지 |
| 정렬 | 계약일자 내림차순 |
| 페이지네이션 | 15건 단위 |

## API 연동 요약

- 매매: `RTMSDataSvcAptTradeDev`
- 전월세: `RTMSDataSvcAptRent`
- 파라미터: `LAWD_CD=41173`, `DEAL_YMD=YYYYMM`

## Vercel 배포

### 1) 대시보드에서 GitHub 연동 (권장)

1. [Vercel](https://vercel.com) → **Add New → Project**
2. `webpayrin7-afk/actual-transaction-data` Import
3. Framework Preset: **Next.js**
4. Environment Variables에 `MOLIT_API_KEY` 추가 (선택)
5. **Deploy**

이후 `main` 푸시마다 Production, PR마다 Preview가 자동 배포됩니다.

### 2) CLI / GitHub Actions

```bash
npm i -g vercel
vercel login
vercel link
vercel env add MOLIT_API_KEY
vercel --prod
```

GitHub Actions(`.github/workflows/deploy-vercel.yml`)를 쓰려면 아래 Secrets가 필요합니다.

| Secret | 설명 |
|--------|------|
| `VERCEL_TOKEN` | [Account Tokens](https://vercel.com/account/tokens) |
| `VERCEL_ORG_ID` | `.vercel/project.json`의 `orgId` |
| `VERCEL_PROJECT_ID` | `.vercel/project.json`의 `projectId` |

### 설정 파일

- `vercel.json` — Next.js, 리전 `icn1`(서울)
- `.github/workflows/deploy-vercel.yml` — Preview/Production 배포 워크플로
