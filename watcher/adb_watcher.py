#!/usr/bin/env python3
"""
ADB Image Watcher for KakaoTalk

BlueStacks 내 카카오톡 이미지 폴더를 모니터링하고 새 이미지를 브릿지 서버로 전송합니다.

사용법:
    python adb_watcher.py [--port PORT] [--interval SECONDS] [--bridge-url URL]

환경변수:
    ADB_PORT - BlueStacks ADB 포트 (기본: 5555)
    BRIDGE_URL - 브릿지 서버 URL (기본: http://localhost:8787/webhook/image)
    IMAGE_WATCH_DIR - 로컬 이미지 저장 경로

요구사항:
    - BlueStacks ADB 활성화 (Settings > Advanced > Android Debug Bridge)
    - Python 3.8+
    - requests 라이브러리: pip install requests
"""

import subprocess
import os
import sys
import time
import base64
import argparse
import json
import hashlib
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: requests 라이브러리가 필요합니다.")
    print("설치: pip install requests")
    sys.exit(1)


# ============================================================
# 기본 설정 (환경변수로 오버라이드 가능)
# ============================================================
DEFAULT_ADB_PORT = os.environ.get("ADB_PORT", "5555")
DEFAULT_BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://localhost:8787/webhook/image")
DEFAULT_LOCAL_PATH = os.environ.get("IMAGE_WATCH_DIR", "./kakao-images")
DEFAULT_CHECK_INTERVAL = 3  # 초

# BlueStacks 5 ADB 경로 (시스템 adb가 없으면 이것 사용)
BLUESTACK_ADB = os.environ.get(
    "BLUESTACK_ADB_PATH",
    "C:/Program Files/BlueStacks_nxt/HD-Adb.exe"
)

# 카카오톡 이미지 저장 경로 (Android)
REMOTE_PATHS = [
    "/sdcard/Pictures/KakaoTalk/",
    "/sdcard/Download/KakaoTalk/",
    "/sdcard/KakaoTalkDownload/",
]


# ============================================================
# 유틸리티 함수
# ============================================================
def log(message, level="INFO"):
    """타임스탬프와 함께 로그 출력"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    prefix = {"INFO": "[i]", "OK": "[OK]", "WARN": "[!]", "ERR": "[X]", "IMG": "[IMG]"}.get(level, "-")
    try:
        print(f"[{timestamp}] {prefix} {message}", flush=True)
    except UnicodeEncodeError:
        print(f"[{timestamp}] {prefix} {message.encode('ascii', 'replace').decode()}", flush=True)


# 처리된 파일 관리
_processed_files = set()
_processed_hashes = set()


def load_processed_data(data_dir):
    """처리된 파일/해시 목록 로드"""
    global _processed_files, _processed_hashes

    files_path = os.path.join(data_dir, "processed_files.json")
    hashes_path = os.path.join(data_dir, "processed_hashes.json")

    try:
        if os.path.exists(files_path):
            with open(files_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                _processed_files = set(data.get("files", []))
                log(f"파일 목록에서 {len(_processed_files)}개 로드됨")
    except Exception as e:
        log(f"파일 목록 로드 실패: {e}", "WARN")

    try:
        if os.path.exists(hashes_path):
            with open(hashes_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                _processed_hashes = set(data.get("hashes", []))
                log(f"해시 목록에서 {len(_processed_hashes)}개 로드됨")
    except Exception as e:
        log(f"해시 목록 로드 실패: {e}", "WARN")


def save_processed_data(data_dir):
    """처리된 파일/해시 목록 저장"""
    files_path = os.path.join(data_dir, "processed_files.json")
    hashes_path = os.path.join(data_dir, "processed_hashes.json")

    try:
        with open(files_path, 'w', encoding='utf-8') as f:
            json.dump({
                "files": list(_processed_files),
                "updated_at": datetime.now().isoformat()
            }, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log(f"파일 목록 저장 실패: {e}", "WARN")

    try:
        with open(hashes_path, 'w', encoding='utf-8') as f:
            json.dump({
                "hashes": list(_processed_hashes),
                "updated_at": datetime.now().isoformat()
            }, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log(f"해시 목록 저장 실패: {e}", "WARN")


def compute_file_hash(filepath):
    """파일 내용의 MD5 해시 계산"""
    try:
        with open(filepath, 'rb') as f:
            return hashlib.md5(f.read()).hexdigest()
    except Exception:
        return None


def is_duplicate_content(filepath):
    """파일 내용이 이미 처리되었는지 확인"""
    file_hash = compute_file_hash(filepath)
    if file_hash and file_hash in _processed_hashes:
        log(f"중복 내용 감지 (해시: {file_hash[:8]}...), 스킵", "WARN")
        return True
    return False


def mark_content_processed(filepath):
    """파일 내용을 처리 완료로 표시"""
    file_hash = compute_file_hash(filepath)
    if file_hash:
        _processed_hashes.add(file_hash)


# ============================================================
# ADB 함수
# ============================================================
_ADB_PATH = None


def get_adb_path():
    """ADB 실행 파일 경로 결정"""
    global _ADB_PATH
    if _ADB_PATH:
        return _ADB_PATH

    # 시스템 PATH에서 adb 확인
    try:
        result = subprocess.run(
            "where adb" if sys.platform == "win32" else "which adb",
            shell=True, capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            _ADB_PATH = "adb"
            return _ADB_PATH
    except Exception:
        pass

    # BlueStacks ADB 확인
    if os.path.exists(BLUESTACK_ADB):
        _ADB_PATH = f'"{BLUESTACK_ADB}"'
        return _ADB_PATH

    _ADB_PATH = "adb"
    return _ADB_PATH


def find_adb_port():
    """BlueStack ADB 포트 자동 감지"""
    adb_path = get_adb_path()
    ports_to_try = ["5555", "5556", "5557", "5558"]

    for port in ports_to_try:
        try:
            result = subprocess.run(
                f'{adb_path} connect 127.0.0.1:{port}',
                shell=True, capture_output=True, text=True, timeout=5
            )
            if "connected" in result.stdout.lower() or "already" in result.stdout.lower():
                log(f"ADB 포트 발견: {port}", "OK")
                return port
        except subprocess.TimeoutExpired:
            continue
        except Exception:
            continue

    return None


def adb_command(cmd, port):
    """ADB 명령 실행"""
    adb_path = get_adb_path()
    full_cmd = f'{adb_path} -s 127.0.0.1:{port} {cmd}'
    try:
        result = subprocess.run(
            full_cmd, shell=True, capture_output=True, text=True, timeout=30
        )
        return result.stdout.strip(), result.returncode
    except subprocess.TimeoutExpired:
        return "TIMEOUT", -1
    except Exception as e:
        return str(e), -1


def find_kakao_image_path(port):
    """카카오톡 이미지 저장 경로 찾기"""
    for path in REMOTE_PATHS:
        output, code = adb_command(f"shell ls -la {path}", port)
        if code == 0 and "No such file" not in output and output.strip():
            log(f"카카오톡 이미지 경로 발견: {path}", "OK")
            return path
    return None


def get_remote_files(remote_path, port):
    """원격 폴더의 파일 목록 조회 (최신순)"""
    output, code = adb_command(f"shell ls -t {remote_path}", port)
    if code != 0 or not output or "No such file" in output:
        return []

    files = []
    for line in output.split('\n'):
        filename = line.strip()
        if filename and not filename.startswith('ls:') and not filename.startswith('total'):
            if any(filename.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp']):
                files.append(filename)
    return files


def pull_file(remote_path, filename, local_path, port):
    """파일 다운로드"""
    remote = f"{remote_path}{filename}"
    local = os.path.join(local_path, filename)

    output, code = adb_command(f'pull "{remote}" "{local}"', port)

    if code == 0 and os.path.exists(local):
        return local
    return None


# ============================================================
# 브릿지 통신
# ============================================================
def send_to_bridge(filepath, filename, bridge_url):
    """브릿지 서버로 이미지 전송"""
    try:
        with open(filepath, 'rb') as f:
            image_data = base64.b64encode(f.read()).decode('utf-8')

        payload = {
            "type": "image",
            "source": "adb-watcher",
            "imagePath": filepath,
            "imageBase64": image_data,
            "filename": filename,
            "timestamp": datetime.now().isoformat()
        }

        response = requests.post(bridge_url, json=payload, timeout=30)

        if response.status_code == 200:
            result = response.json()
            log(f"브릿지 전송 완료: {result.get('message', 'OK')}", "OK")
            return True
        else:
            log(f"브릿지 응답 오류: {response.status_code}", "ERR")
            return False

    except requests.exceptions.ConnectionError:
        log("브릿지 서버 연결 실패 (서버가 실행 중인지 확인)", "ERR")
        return False
    except Exception as e:
        log(f"브릿지 전송 실패: {e}", "ERR")
        return False


# ============================================================
# 메인 루프
# ============================================================
def main():
    global _processed_files

    parser = argparse.ArgumentParser(description="KakaoTalk ADB Image Watcher")
    parser.add_argument("--port", "-p", default=DEFAULT_ADB_PORT, help="ADB 포트 (기본: 5555)")
    parser.add_argument("--interval", "-i", type=int, default=DEFAULT_CHECK_INTERVAL, help="체크 간격 (초)")
    parser.add_argument("--auto-port", "-a", action="store_true", help="ADB 포트 자동 감지")
    parser.add_argument("--reset", "-r", action="store_true", help="처리된 파일 목록 초기화")
    parser.add_argument("--bridge-url", "-b", default=DEFAULT_BRIDGE_URL, help="브릿지 서버 URL")
    parser.add_argument("--local-path", "-l", default=DEFAULT_LOCAL_PATH, help="로컬 이미지 저장 경로")
    args = parser.parse_args()

    print()
    print("=" * 50)
    print("   KakaoTalk ADB Image Watcher")
    print("=" * 50)
    print()

    # 로컬 디렉토리 생성
    local_path = os.path.abspath(args.local_path)
    os.makedirs(local_path, exist_ok=True)
    log(f"로컬 저장 경로: {local_path}")

    # 처리된 파일 목록 로드/초기화
    if args.reset:
        _processed_files = set()
        _processed_hashes.clear()
        log("처리된 파일 목록 및 해시 초기화됨", "WARN")
    else:
        load_processed_data(local_path)

    # ADB 포트 결정
    port = args.port
    if args.auto_port:
        log("ADB 포트 자동 감지 중...")
        detected_port = find_adb_port()
        if detected_port:
            port = detected_port
        else:
            log(f"자동 감지 실패, 기본 포트 사용: {port}", "WARN")

    # ADB 연결 확인
    log(f"ADB 연결 시도: 127.0.0.1:{port}")
    output, code = adb_command("shell echo connected", port)
    if code != 0 or "connected" not in output:
        log("ADB 연결 실패! BlueStacks가 실행 중인지 확인하세요.", "ERR")
        print()
        print("해결 방법:")
        print("  1. BlueStacks 실행")
        print("  2. BlueStacks > Settings > Advanced > Android Debug Bridge 활성화")
        print("  3. 다시 시도: python adb_watcher.py --auto-port")
        print()
        sys.exit(1)

    log("ADB 연결 성공!", "OK")

    # 카카오톡 이미지 경로 찾기
    remote_path = find_kakao_image_path(port)
    if not remote_path:
        log("카카오톡 이미지 폴더를 찾을 수 없습니다.", "ERR")
        print()
        print("확인 사항:")
        print("  1. 카카오톡에서 이미지를 한 번 이상 수신했는지 확인")
        print("  2. 카카오톡 설정 > 채팅 > '사진 자동 저장' 활성화")
        print()
        sys.exit(1)

    # 시작 시 기존 파일 스킵
    if not _processed_files:
        existing_files = get_remote_files(remote_path, port)
        for f in existing_files:
            _processed_files.add(f)
        if existing_files:
            log(f"기존 파일 {len(existing_files)}개 스킵")
        save_processed_data(local_path)

    print()
    log(f"모니터링 시작 (체크 간격: {args.interval}초)")
    log(f"브릿지 URL: {args.bridge_url}")
    log("Ctrl+C로 종료")
    print("-" * 50)

    try:
        while True:
            try:
                files = get_remote_files(remote_path, port)

                for filename in files:
                    if filename not in _processed_files:
                        log(f"새 이미지 감지: {filename}", "IMG")

                        # 다운로드
                        local_file = pull_file(remote_path, filename, local_path, port)
                        if local_file:
                            log(f"다운로드 완료: {os.path.basename(local_file)}")

                            # 해시 기반 중복 체크
                            if is_duplicate_content(local_file):
                                log(f"동일 내용 이미 처리됨, 스킵: {filename}")
                            else:
                                # 브릿지로 전송
                                send_to_bridge(local_file, filename, args.bridge_url)
                                mark_content_processed(local_file)
                        else:
                            log(f"다운로드 실패: {filename}", "WARN")

                        # 처리 완료 표시
                        _processed_files.add(filename)
                        save_processed_data(local_path)

                time.sleep(args.interval)

            except KeyboardInterrupt:
                raise
            except Exception as e:
                log(f"루프 오류: {e}", "ERR")
                time.sleep(args.interval)

    except KeyboardInterrupt:
        print()
        log("모니터링 중지")
        save_processed_data(local_path)
        log(f"총 {len(_processed_files)}개 파일 처리됨")


if __name__ == "__main__":
    main()
