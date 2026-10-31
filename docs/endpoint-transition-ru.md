# Staging → production: отдельная авторизация, не исправление endpoint на месте

Причина 3d подтверждена: `existing_endpoint_mismatch`. Не повторять обычный helper с production-инструкцией на staging-привязке и не объявлять её отозванной. Не переустанавливать runtime ради этого отказа.

## Подготовка без изменения рабочей привязки

Из проверенного нового архива (после review/publish, не из старого v0.2.87) с **точными** OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH активного профиля:

1. `node scripts/endpoint-transition.mjs plan /ABS/transition.json`. План содержит endpoints, ID старой установки, hashes файлов; без credentials. Изменение конфигурации/привязки после планирования инвалидирует план. На 3d пока НЕ запускать даже план без доступа/согласованного профиля.
2. Показать владельцу профиля: старая staging-установка/история остаются; новая production-авторизация создаст **другую** установку. Это не перенос строк истории между базами. Получить явное подтверждение перехода для exact confirmation hash. Не считать прошлое разрешение диагностировать агент таким подтверждением.
3. Создать свежую production-инструкцию из нужного аккаунта в приложении. `node scripts/endpoint-transition.mjs begin /ABS/transition.json CONFIRMATION REQUEST_ID`. Только это действие начинает независимую авторизацию в candidate-state. Старый secret используется только для подписанной проверки staging, никогда не отправляется production.
4. Явное Approve в приложении инициирующего аккаунта; затем `poll` до credential_saved и `ready`. Истечение → новая инструкция/новый запрос; никакого автоматического Approve. Нет приватных proofs/codes в CLI/chat. Старые config, credentials, spool/cursors, manager и данные не меняются.

## Последующий host cutover — отдельное явное подтверждение

Helper **не выполняет activation**. Перед ним нужны actual host idle, адресная проверка config/service/manager, приватная копия config + active sidewisp (SQLite backup API, не копирование живых WAL), контрольные hashes и конкретный rollback. Не останавливать чужие задачи/Gateway при занятом host.

На idle-host с согласованным владельцем окном: остановить только согласованные collector/manager (если runtime требует Gateway restart — согласовать его явно); сохранить исходные authorization pending-файлы в приватный архив; атомарно установить отдельно одобренный production installation.json и endpoint config, сохранить **существующий spool и его курсоры**. При первом запуске штатный `quarantineOtherInstallations(newId)` обязан изолировать старый backlog, а не replay под новым аккаунтом. Перенастроить проверенный manager штатным installer на новый endpoint, не менять его owner/profile. Запустить; требовать свежий принятый heartbeat, usage/context, подписанную задачу с точным ответом, native cron/notification и отсутствие duplicate/replay. Старая staging запись/история остаются, становятся offline, не удаляются.

Откат до принятой новой работы: вернуть exact прежний config/credential и manager, сохранить новый production профиль отдельно, никогда не replay его backlog в staging. После новой работы откат — отдельно сверенный: не удалять новое состояние/данные. Никакого массового переноса, revoke/delete или копирования staging secret в production.

Локальные тесты этого PR проверяют **подготовку**, не принимают реальный 3d cutover/Android. Рабочая привязка не менялась. Публикация/установка этого helper и actual host lifecycle остаются gate выпуска, не считаются уже выполненными.
