package io.jenkins.plugins.artifactexplorer;

import edu.umd.cs.findbugs.annotations.CheckForNull;
import edu.umd.cs.findbugs.annotations.NonNull;
import hudson.model.DirectoryBrowserSupport;
import hudson.model.Run;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import jenkins.util.SystemProperties;
import jenkins.util.VirtualFile;

/**
 * Read-only view of a build's archived artifacts, built on {@link jenkins.model.ArtifactManager#root()} so it works
 * for any artifact manager (local disk, S3, ...). All paths handled here are relative to the artifact root and use
 * {@code /} as the separator.
 */
public final class ArtifactTree {

    /** Mirrors the opt-out that {@link DirectoryBrowserSupport} honours. */
    private static final String ALLOW_SYMLINK_ESCAPE =
            DirectoryBrowserSupport.class.getName() + ".allowSymlinkEscape";

    private ArtifactTree() {}

    /** One file or directory directly under a directory. */
    public record Entry(String name, String path, boolean directory, long size, long lastModified) {}

    /** Result of a (possibly truncated) listing. */
    public record Listing<T>(List<T> items, boolean truncated) {}

    /** Preview metadata and bounded UTF-8 text content for a single artifact file. */
    public record FilePreview(
            String name,
            String path,
            long size,
            long lastModified,
            boolean binary,
            boolean truncated,
            @CheckForNull String text) {}

    /**
     * Validates and normalizes a user supplied relative path.
     *
     * @param raw path as received from the client, may be {@code null}
     * @return the normalized path without leading or trailing slash ({@code ""} for the root)
     * @throws IllegalArgumentException if the path tries to escape the artifact root
     */
    @NonNull
    public static String sanitize(String raw) {
        if (raw == null || raw.isEmpty()) {
            return "";
        }
        if (raw.indexOf('\0') >= 0 || raw.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Illegal character in path");
        }
        StringBuilder out = new StringBuilder();
        for (String segment : raw.split("/")) {
            if (segment.isEmpty()) {
                continue; // tolerate leading, trailing and doubled slashes
            }
            if (segment.equals(".") || segment.equals("..")) {
                throw new IllegalArgumentException("Illegal path segment: " + segment);
            }
            if (out.length() > 0) {
                out.append('/');
            }
            out.append(segment);
        }
        return out.toString();
    }

    /**
     * Keeps symlinks from exposing anything outside the artifact root, like core's directory browser does.
     *
     * <p>Only artifact managers backed by the local filesystem (those whose {@link VirtualFile#toURI()} is a
     * {@code file:} URI) can contain symlinks, so the check is a no-op for remote managers such as S3.
     */
    private static final class SymlinkGuard {
        @CheckForNull
        private final Path realRoot;

        SymlinkGuard(VirtualFile root) {
            Path real = null;
            try {
                if (!SystemProperties.getBoolean(ALLOW_SYMLINK_ESCAPE) && root != null && root.exists()) {
                    real = realPath(root);
                }
            } catch (IOException e) {
                real = null;
            }
            this.realRoot = real;
        }

        /** @return the symlink-free path, or {@code null} if the file is not local or cannot be resolved */
        @CheckForNull
        private static Path realPath(VirtualFile file) {
            URI uri = file.toURI();
            if (!"file".equals(uri.getScheme())) {
                return null;
            }
            try {
                return Path.of(uri).toRealPath();
            } catch (IOException | RuntimeException e) {
                return null;
            }
        }

        /** Whether {@code file} resolves to somewhere outside the root, or cannot be resolved (e.g. dangling link). */
        boolean escapes(VirtualFile file) {
            if (realRoot == null) {
                return false;
            }
            Path real = realPath(file);
            return real == null || !real.startsWith(realRoot);
        }
    }

    private static VirtualFile resolve(VirtualFile root, String sanitizedPath) {
        VirtualFile current = root;
        if (!sanitizedPath.isEmpty()) {
            for (String segment : sanitizedPath.split("/")) {
                current = current.child(segment);
            }
        }
        return current;
    }

    /**
     * Lists the direct children of a directory, directories first, then by case-insensitive name.
     *
     * @param limit maximum number of entries to return
     * @return the listing, or {@code null} if {@code path} is not a directory inside the artifact root
     */
    public static Listing<Entry> children(Run<?, ?> run, String path, int limit) throws IOException {
        String clean = sanitize(path);
        VirtualFile root = run.getArtifactManager().root();
        if (root == null || !root.exists() || !root.isDirectory()) {
            return clean.isEmpty() ? new Listing<>(new ArrayList<>(), false) : null;
        }
        SymlinkGuard guard = new SymlinkGuard(root);
        VirtualFile dir = resolve(root, clean);
        if (!dir.isDirectory() || guard.escapes(dir)) {
            return null;
        }
        VirtualFile[] rawChildren = dir.list();
        List<Entry> entries = new ArrayList<>();
        for (VirtualFile child : rawChildren) {
            if (guard.escapes(child)) {
                continue;
            }
            boolean isDir = child.isDirectory();
            String childPath = clean.isEmpty() ? child.getName() : clean + "/" + child.getName();
            entries.add(new Entry(
                    child.getName(), childPath, isDir, isDir ? 0 : child.length(), child.lastModified()));
        }
        entries.sort(Comparator.comparing(Entry::directory)
                .reversed()
                .thenComparing(e -> e.name().toLowerCase(Locale.ROOT)));
        boolean truncated = entries.size() > limit;
        return new Listing<>(truncated ? new ArrayList<>(entries.subList(0, limit)) : entries, truncated);
    }

    /**
     * Lists every file (not directory) in the build's artifacts as relative paths, for client side search.
     *
     * @param limit maximum number of paths to return
     */
    public static Listing<String> allFiles(Run<?, ?> run, int limit) throws IOException {
        VirtualFile root = run.getArtifactManager().root();
        if (root == null || !root.exists() || !root.isDirectory()) {
            return new Listing<>(new ArrayList<>(), false);
        }
        SymlinkGuard guard = new SymlinkGuard(root);
        Collection<String> all = root.list("**/*", null, false);
        if (all.isEmpty()) {
            return new Listing<>(new ArrayList<>(), false);
        }
        List<String> sorted = new ArrayList<>(all.size());
        for (String file : all) {
            if (!guard.escapes(resolve(root, file))) {
                sorted.add(file);
            }
        }
        sorted.sort(String.CASE_INSENSITIVE_ORDER);
        boolean truncated = sorted.size() > limit;
        return new Listing<>(truncated ? new ArrayList<>(sorted.subList(0, limit)) : sorted, truncated);
    }

    /**
     * Reads a bounded preview of a single artifact file.
     *
     * @param maxBytes maximum number of bytes to read when decoding text
     * @return the preview, or {@code null} if {@code path} does not refer to a readable file inside the artifact root
     */
    @CheckForNull
    public static FilePreview preview(Run<?, ?> run, String path, int maxBytes) throws IOException {
        String clean = sanitize(path);
        if (clean.isEmpty()) {
            return null;
        }
        VirtualFile root = run.getArtifactManager().root();
        if (root == null || !root.exists() || !root.isDirectory()) {
            return null;
        }
        SymlinkGuard guard = new SymlinkGuard(root);
        VirtualFile file = resolve(root, clean);
        if (!file.isFile() || guard.escapes(file)) {
            return null;
        }
        long size = file.length();
        long lastModified = file.lastModified();
        int cap = Math.max(0, maxBytes);
        byte[] buf;
        try (InputStream in = file.open()) {
            buf = in.readNBytes(cap + 1);
        } catch (IOException e) {
            return null;
        }
        boolean truncated = buf.length > cap || size > cap;
        int len = Math.min(buf.length, cap);
        int checkLen = Math.min(len, 8192);
        boolean binary = false;
        for (int i = 0; i < checkLen; i++) {
            if (buf[i] == 0) {
                binary = true;
                break;
            }
        }
        String text = binary ? null : new String(buf, 0, len, StandardCharsets.UTF_8);
        return new FilePreview(file.getName(), clean, size, lastModified, binary, truncated, text);
    }
}
