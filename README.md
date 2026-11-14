# Shashka — Cloudflare нұсқасы

Ойын коды (`server.js`, `lib/`, `public/`) Render нұсқасымен бірдей. Қосылғаны: `cf/` папкасы (адаптер) және `wrangler.toml`.

## 1. Сынақ (нағыз ботқа әсер етпейді)
1. GitHub-та жаңа репо ашып, осы файлдардың бәрін жүкте (папкаларымен).
2. Cloudflare → Workers & Pages → Create → Import a repository.
   Build command: бос қалдыр. Deploy command: `npx wrangler deploy`
3. Сілтеме: https://shashka-cf.raxatarzubaev.workers.dev
4. Браузерде екі терезе аш: `/?dev=Ali` және `/?dev=Vali`. Екеуі де "find" басқанда ойын басталуы керек.

Сынақ режимінде (wrangler.toml → [vars]) DEV=1, SKIP_WEBHOOK=1 және Redis қосылмаған, сондықтан нағыз деректер мен бот қозғалмайды.

## 2. Көшу (сынақ жақсы болғанда ғана)
1. Cloudflare → Worker → Settings → Variables and Secrets → Secret қос:
   BOT_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (Render-дегі мәндермен бірдей).
2. wrangler.toml → [vars] ішінен DEV, SKIP_WEBHOOK және REDIS_PREFIX жолдарын өшір. Commit.
3. Render-ді сол сәтте тоқтат (екі сервер бір Redis-ке бір мезгілде жазса, деректер бұзылады).
4. BotFather / ботта Mini App сілтемесі MINI_APP_URL-ға сәйкес екенін тексер.
