package io.jenkins.plugins.artifactexplorer;

import hudson.Extension;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import jenkins.util.HttpServletFilter;

/**
 * Makes the classic {@code <build>/artifact/<dir>/} URL show the explorer instead of the built-in directory listing.
 *
 * <p>Only directory page loads from a browser are taken over. File downloads, {@code *zip*}, {@code *view*},
 * {@code *fingerprint*} and any request with {@code ?legacy=1} fall through to core's
 * {@link hudson.model.DirectoryBrowserSupport}, which keeps serving the actual bytes (with its CSP and symlink
 * handling).
 */
@Extension
public class ArtifactExplorerFilter implements HttpServletFilter {

    /**
     * {@code <view/job prefix>/<build number or permalink>/artifact/<dir>/}; group 1 is the build URL, group 2 the
     * directory below the artifact root. Directory requests always end in a slash; anything containing a {@code *}
     * (core's special tokens) is excluded.
     */
    static final Pattern DIRECTORY_REQUEST =
            Pattern.compile("^((?:/(?:view|job)/[^/]+)+/(?:\\d+|last[A-Za-z]*Build))/artifact/((?:[^/*]+/)*)$");

    @Override
    public boolean handle(HttpServletRequest req, HttpServletResponse rsp) throws IOException, ServletException {
        if (!isBrowserGet(req) || "1".equals(req.getParameter("legacy"))) {
            return false;
        }
        ExplorerConfiguration config = ExplorerConfiguration.get();
        if (config == null || !config.isReplaceClassicBrowser()) {
            return false;
        }
        String path = req.getRequestURI().substring(req.getContextPath().length());
        Matcher m = DIRECTORY_REQUEST.matcher(path);
        if (!m.matches()) {
            return false;
        }
        req.setAttribute(ArtifactExplorerAction.PATH_ATTRIBUTE, decode(m.group(2)));
        jakarta.servlet.RequestDispatcher dispatcher = req.getRequestDispatcher(m.group(1) + "/artifact-explorer/");
        if (dispatcher == null) {
            return false;
        }
        dispatcher.forward(req, rsp);
        return true;
    }

    private static boolean isBrowserGet(HttpServletRequest req) {
        if (!"GET".equals(req.getMethod())) {
            return false;
        }
        String accept = req.getHeader("Accept");
        return accept != null && accept.contains("text/html");
    }

    private static String decode(String rawPath) {
        try {
            return java.net.URLDecoder.decode(rawPath.replace("+", "%2B"), java.nio.charset.StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return "";
        }
    }
}
