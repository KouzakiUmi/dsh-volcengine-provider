// This executable is visible only on the login CLI's private PATH. It replaces
// that process's rundll32 URL opener, not the system executable or association.
using System;
using System.IO;
using System.Net;
using System.Text;

internal static class BrowserBridge {
  private static int Main(string[] args) {
    try {
      if (args.Length != 2 || !String.Equals(args[0], "url.dll,FileProtocolHandler", StringComparison.OrdinalIgnoreCase)) return 2;
      Uri target;
      if (!Uri.TryCreate(args[1], UriKind.Absolute, out target) || target.Scheme != "https" || target.Host != "ark.volcengine.com" || target.Port != 443 || target.UserInfo.Length != 0) return 2;
      if (target.AbsolutePath != "/arkcli/login" && target.AbsolutePath != "/region:cn-beijing/arkcli/login") return 2;
      Uri endpoint;
      if (!Uri.TryCreate(Environment.GetEnvironmentVariable("DSH_ARK_BROWSER_ENDPOINT"), UriKind.Absolute, out endpoint) || endpoint.Scheme != "http" || endpoint.Host != "127.0.0.1" || endpoint.UserInfo.Length != 0 || endpoint.AbsolutePath != "/launch" || endpoint.Query.Length != 0 || endpoint.Fragment.Length != 0) return 2;
      string token = Environment.GetEnvironmentVariable("DSH_ARK_BROWSER_TOKEN");
      if (String.IsNullOrEmpty(token) || token.Length != 64) return 2;
      byte[] body = Encoding.UTF8.GetBytes(args[1]);
      if (body.Length > 16384) return 2;
      HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
      request.Proxy = null;
      request.UseDefaultCredentials = false;
      request.Method = "POST";
      request.Timeout = 5000;
      request.ReadWriteTimeout = 5000;
      request.ContentType = "text/plain; charset=utf-8";
      request.Headers["X-DSH-Ark-Browser"] = token;
      request.ContentLength = body.Length;
      using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
      using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) return (int)response.StatusCode == 204 ? 0 : 1;
    } catch { return 1; }
  }
}
