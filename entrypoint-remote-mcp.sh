#!/bin/bash

set -euo pipefail

# nginx.conf doesn't support environment variables,
# so we substitute at run time

sed \
  -e "s/<MCP_SERVER_PORT>/${MCP_SERVER_PORT}/g" \
  -e "s|<MCP_SERVER_ENDPOINT>|${MCP_SERVER_ENDPOINT}|g" \
  /etc/nginx/templates/mcp-server.conf.template > /etc/nginx/sites-enabled/mcp-server.conf

sed \
  -e "s/<CREDO_PORT>/${CREDO_PORT}/g" \
  -e "s|<CREDO_ENDPOINT>|${CREDO_ENDPOINT}|g" \
  /etc/nginx/templates/credo.conf.template > /etc/nginx/sites-enabled/credo.conf

# run in foreground as pid 1
exec nginx -g "daemon off;"
