#!/bin/bash
# 더블클릭하면 투표 서버 + 인터넷 참여 주소가 함께 켜져요.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 설치되어 있지 않아요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
  open "https://nodejs.org"
  read -p "엔터를 누르면 닫혀요"
  exit 1
fi
node server.js --online --open
