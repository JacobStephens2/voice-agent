# Keeplore document roots

Keeplore is served from files by Apache. Promotion is only real once the two
vhosts point at the active Release rather than into the live checkout:

| vhost | before | after |
| --- | --- | --- |
| `keeplore.app` | `/var/www/keeplore.app/ui` | `/opt/keeplore/current/ui` |
| `api.keeplore.app` | `/var/www/keeplore.app/api` | `/opt/keeplore/current/api` |

`ops/keeplore/repoint-keeplore-vhosts.sh` performs that cutover: it backs up the
current vhost files, rewrites only the `DocumentRoot` and matching `<Directory>`
lines, validates the configuration with `apache2ctl configtest`, reloads
gracefully, and restores the backups if the reload or the health check fails.

Until the cutover runs, Keeplore keeps serving from the live checkout and no
Promotion can be verified.
