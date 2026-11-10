# Lokit — backend общей аналитики

Здесь находится отдельный Cloudflare Worker с базой D1. Для публикации на GitHub Pages он **не нужен**; разместите его отдельно после настройки Cloudflare.

```bash
npx wrangler login
npx wrangler d1 create lokit-analytics
```

Скопируйте полученный `database_id` в `wrangler.toml` вместо `REPLACE_WITH_YOUR_D1_DATABASE_UUID`. Проверьте `ALLOWED_ORIGIN`: для сайта `https://teenkode.github.io/lokit/` он равен `https://teenkode.github.io`.

```bash
npx wrangler d1 migrations apply lokit-analytics --remote
npx wrangler deploy
```

Скопируйте адрес Worker в `js/analytics-config.js` публичного сайта. После обновления GitHub Pages общая статистика начнёт наполняться событиями.

В `wrangler.toml` установлен ежедневный Cron Trigger на **03:00 UTC**. Он запускает удаление событий, полученных более **90 дней** назад. При развёртывании обязательно примените обе миграции (`0001_initial.sql`, `0002_retention_index.sql`) и проверьте задачу на странице Worker в Cloudflare Dashboard.

Сведения о файлах на сервер не поступают. Участие пользователя в отправке аналитики выключено по умолчанию: включается только через отдельный переключатель на сайте. Общие цифры отражают лишь включивших отправку пользователей, а не всех посетителей.

На Worker есть `POST /api/events`, `GET /api/stats?days=7|30|90` и `GET /api/health`.

Доступ по Origin — только ограничение для обычных браузеров, **не антибот-защита**. Для открытого проекта дополнительно настройте Cloudflare WAF / Rate Limiting для `/api/events` и мониторинг D1. Эти ограничения требуют доступа к вашему аккаунту и в исходниках не активированы. Само наличие `Origin` не предотвращает запросы с подделанным заголовком. Worker не сохраняет IP-адреса и не читает пользовательские файлы. Не отправляйте на него секретные данные.

Официальная инструкция D1: https://developers.cloudflare.com/d1/get-started/
