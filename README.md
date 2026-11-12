# Antigravity Repair Tool (`antigravity-repair`)

Автоматическое устранение бага сброса статуса бесед в Google Antigravity после перезагрузки приложения или ПК:
1. Все беседы становятся непрочитанными (`serverUnread: true` / синие точки).
2. Архивные беседы вываливаются в активный список.
3. Беседы получают статус внешних (`source=17` / `CORTEX_TRAJECTORY_SOURCE_CLI`) и теряют локальные аннотации.

---

## Причина бага (Root Cause)

1. **Потеря аннотаций при старте**: При перезапуске Antigravity Language Server подгружает беседы из облачного потока со статусом `source=17` (CLI) без локальных аннотаций (`title`, `archived`, `lastUserViewTime`).
2. **Формула непрочитанности**: В коде клиента Antigravity статус непрочитанности вычисляется как:
   ```javascript
   function Em(a) {
       if (a.annotations?.markedAsUnread) return true;
       var b = a.lastModifiedTime?.seconds;
       return b ? b > (a.annotations?.lastUserViewTime ? ff(a.annotations.lastUserViewTime) / 1000 : 0) : false;
   }
   ```
   Когда аннотации отсутствуют, `lastUserViewTime` принимается за 0, и **все беседы помечаются как непрочитанные**.
3. **Protobuf-декодирование**: Поле `archived` в `ConversationAnnotations` является **полем 4** (`0x20`), а не полем 2 (`0x10`). При неверной сериализации архивные беседы теряют флаг архивации и также попадают в непрочитанные.
4. **Коллизия PID сторожа**: Обычная проверка `Get-Process -Id $old` без валидации имени процесса блокирует запуск watchdog после перезагрузки ОС, если этот же PID случайно выделяется системному процессу Windows.

---

## Структура решения

- **`ag-repair.ps1`**: Однократный запуск анализа и исправления: автоматически находит порт и CSRF-токен работающего `language_server.exe`, считывает дамп сводок и передаёт в `ls_write_all.js`.
- **`ls_write_all.js`**: Пакетная перезапись сводок в Language Server через gRPC (`JetboxWriteSummary`):
  - Приводит `source` к `0` (LOCAL / UNSPECIFIED).
  - Считывает `.pbtxt` из `~/.gemini/antigravity/annotations/` и формирует правильный Protobuf-пакет аннотаций:
    - `1: title`
    - `4: archived` (`0x20, 0x01`)
    - `5: archival_status_timestamp` (`0x2a`)
    - `7: last_user_view_time` (`0x3a`)
    - `8: marked_as_unread` (`0x40, 0x01`)
  - Выравнивает `last_user_view_time` относительно `last_modified_time` для предотвращения ложного статуса непрочитанности.
- **`ag-watchdog.ps1`**: Фоновый сторож с защитой от PID-коллизий (проверяет имя процесса PowerShell). Автоматически подхватывает порт Language Server после перезагрузок.
- **`antigravity_history_repair.vbs`**: Скрытый запуск сторожа без всплывающих окон консоли.
- **`install.ps1`**: Добавление ярлыка в автозагрузку Windows (`shell:startup`).

---

## Установка и использование

### Однократный запуск
```powershell
powershell -ExecutionPolicy Bypass -File .\ag-repair.ps1
```

### Автозапуск в фоне (Windows)
Запустите установщик:
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
Ярлык будет добавлен в папку Автозагрузка Windows (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`), и сторож будет автоматически запускаться при входе в систему.
