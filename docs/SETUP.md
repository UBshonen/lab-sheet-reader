# 개발 환경 셋팅

> 새 컴퓨터에서 이 프로젝트를 처음 열 때 보는 문서.
> 이미 돌아가고 있다면 [STATUS.md](STATUS.md) 로 간다.

---

## 0. 지금 개발 중인 환경

다른 컴퓨터에 같은 환경을 만들 때 이 값들을 맞추면 된다.
버전이 조금 달라도 대체로 동작하지만 **Node 만은 22 이상**이어야 한다.

```text
OS        Windows 11
Node      v22.17.1
npm       10.9.2
Git       2.55.0
셸        PowerShell (Git Bash 도 함께 씀)
에디터     VS Code + Claude Code
```

노트북이 주력이고 데스크탑에서도 만진다. 두 곳의 Claude 세션은 이어지지 않으므로
**작업이 끝나면 STATUS.md 를 갱신하고 push** 한다. 그게 유일한 인수인계다.

---

## 1. 필요한 것

```text
Node.js   22 이상
Git
에디터     VS Code 권장 (필수는 아님)
```

`node` 는 자바스크립트를 브라우저 밖에서 돌리는 프로그램이고,
`npm` 은 거기 딸려 오는 꾸러미 관리자다. 라이브러리를 받아오고 명령을 실행한다.

### 설치 확인

```powershell
node -v
npm -v
git --version
```

Node 가 없으면 [nodejs.org](https://nodejs.org) 에서 LTS 를 받는다.
설치하면 npm 도 함께 깔린다.

### 전역 설치는 없다

프로젝트에 필요한 것은 전부 `npm install` 로 들어간다.

```text
next · typescript · eslint  →  전부 프로젝트 의존성
```

`npx` 가 프로젝트 안의 것을 찾아 쓰므로 `npx tsc`, `npx next` 로 실행하면 된다.

---

## 2. Git 설정

```bash
git config --global user.name  "<이름>"
git config --global user.email "<개인 메일>"
git config --global core.autocrlf true
```

**이 저장소는 개인 프로젝트다. 회사 메일로 커밋하지 않는다.**
한 번 커밋된 메일 주소는 저장소를 공개하는 순간 누구나 볼 수 있고,
나중에 지우려면 기록을 통째로 다시 써야 한다.

새 컴퓨터에서 clone 한 직후, 첫 커밋 전에 확인한다.

```bash
git config user.email      # 이 저장소에 적용되는 값
```

전역 설정이 비어 있으면 도구가 엉뚱한 값을 채워 넣을 수 있으므로
**전역에도 개인 메일을 넣어둔다.** 메일 주소는 다른 개인 저장소와 같아야
GitHub 기여 그래프가 갈라지지 않는다.

> GitHub 설정에서 `Keep my email address private` 을 켜면 커밋에
> `...@users.noreply.github.com` 주소가 대신 쓰인다. 공개 저장소로 돌릴
> 생각이면 이쪽이 안전하다.

`core.autocrlf true` 는 Windows 에서 흔한 설정이다. 저장소에는 줄바꿈을 LF 로
저장하고 작업 폴더에는 CRLF 로 꺼내온다. `git add` 할 때 나오는
`LF will be replaced by CRLF` 경고가 이것 때문인데 **문제는 없다.**

> **용어** — LF 와 CRLF 는 줄바꿈을 나타내는 방식이다. 리눅스·맥은 LF 하나,
> 윈도우는 CR 과 LF 두 글자를 쓴다. 섞이면 파일 전체가 바뀐 것처럼 보여서
> Git 이 자동으로 변환해준다.

---

## 3. 받아서 시작하기

```powershell
git clone https://github.com/<계정>/lab-sheet-reader.git
cd lab-sheet-reader
npm install
```

`npm install` 은 `package.json` 에 적힌 라이브러리를 `node_modules/` 로 받아온다.
저장소에는 목록만 있고 실물은 없으므로 **새 컴퓨터에서는 반드시 한 번 실행**한다.

---

## 4. 환경변수

API 키처럼 **저장소에 올리면 안 되는 값**을 담는 파일을 따로 둔다.

```powershell
copy .env.example .env.local
```

그리고 `.env.local` 을 열어 값을 채운다.

```text
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.6-flash
```

키는 Google AI Studio에서 발급한다.
발급할 때 **월 사용 한도(spend limit)를 낮게 걸어두면** 최악의 경우에도 손해가 막힌다.

```text
.env.example   어떤 값이 필요한지 적어둔 견본.  저장소에 올린다
.env.local     실제 값.  .gitignore 대상.  절대 올리지 않는다
```

키가 코드에 들어가면 브라우저 개발자도구로 그대로 보인다. 남이 가져가서 쓰면
**본인 카드로 결제된다.** 서버 쪽 코드에서만 읽는다.

---

## 5. 실행

```powershell
npm run dev        # localhost:3000
npm run pages:dev  # Cloudflare Pages 로컬 실행
npm run typecheck  # 타입 검사
npm test
```

명령 실행 전 `pwd` 로 위치를 확인한다. 엉뚱한 폴더에서 `npm install` 하면
그 자리에 `node_modules/` 가 생겨버린다.

---

## 6. 시험 자료

실제 스캔본은 **저장소에 올리지 않는다.** 시료 지점명 · 담당자 이름 ·
접수번호가 그대로 들어있다.

```text
samples/     실제 스캔본.  .gitignore 대상.  각 컴퓨터에 알아서 둔다
fixtures/    지점명과 담당자명을 지운 것만.  저장소에 올린다
```

새 컴퓨터에서는 `samples/` 가 비어 있다. 시험해보려면 스캔본을 직접 넣는다.

한 번 커밋된 파일은 나중에 지워도 **기록에는 남는다.** 실수로 올렸다면
커밋을 지우는 것으로는 부족하니, 그때는 바로 알린다.

---

## 7. 스캐너 설정

복합기에서 이렇게 뽑는다. 정확도가 여기서 갈린다.

```text
해상도    300 dpi     200 도 되지만 300 이 안전. 600 은 용량만 커진다
색상      회색조       컬러는 이득 없이 파일만 커진다
형식      PDF         여러 장이 한 파일로 묶인다
```

접수번호 한 뭉치를 한 번에 스캔해서 **파일 하나**로 만든다.
페이지마다 문서 종류를 알아서 판별한다.

---

## 8. Cloudflare Pages 배포

GitHub의 `main` 브랜치를 Cloudflare Pages에 연결한다.

```text
프로젝트 이름       lab-sheet-reader
프레임워크           None
빌드 명령           exit 0
출력 디렉터리       web
루트 디렉터리       비워 둠
```

첫 배포 뒤 프로젝트의 `설정 → 변수 및 비밀`에서 `GEMINI_API_KEY`를
암호화된 Secret으로 추가하고 재배포한다. 연구사에게 주소를 공유하기 전에는
Cloudflare Access로 접근 대상을 제한하고 기관의 외부 AI 전송 기준을 확인한다.

배포 후 GitHub `main`에 push하면 Cloudflare가 새 버전을 자동 배포한다.
