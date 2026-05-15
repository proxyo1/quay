import { NextResponse, type NextRequest } from "next/server";

const APP_HOSTS = new Set(["app.localhost", "app.quay.xyz"]);

function isAppHost(hostname: string): boolean {
  if (APP_HOSTS.has(hostname)) return true;
  return hostname.startsWith("app.");
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const hostname = host.split(":")[0];
  const { pathname } = req.nextUrl;

  if (isAppHost(hostname)) {
    if (pathname.startsWith("/app")) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = `/app${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  if (pathname.startsWith("/app")) {
    const url = req.nextUrl.clone();
    url.host = `app.${hostname}`;
    url.pathname = pathname.replace(/^\/app/, "") || "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
