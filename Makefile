NAME := server-status
DEST := /srv/services/$(NAME)
SERVICE := $(NAME)

.PHONY: build check deploy restart status logs

build:
	pnpm build

check: typecheck test lint

typecheck:
	pnpm typecheck

test:
	pnpm test

lint:
	pnpm lint

# El bundle de esbuild es autocontenido: dist/index.js no necesita node_modules
# en destino. Solo viajan el codigo, el manifiesto y el inventario.
deploy: build
	rsync -av --delete dist/ $(DEST)/dist/
	cp package.json inventory.yaml $(DEST)/
	test -f $(DEST)/.env || { echo "falta $(DEST)/.env"; exit 1; }
	sudo systemctl restart $(SERVICE).service
	sudo systemctl is-active --quiet $(SERVICE).service

restart:
	sudo systemctl restart $(SERVICE).service

status:
	sudo systemctl status $(SERVICE).service --no-pager

logs:
	journalctl -u $(SERVICE).service -n 50 -f
