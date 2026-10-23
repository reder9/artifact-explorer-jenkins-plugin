package io.jenkins.plugins.artifactexplorer;

import hudson.Functions;
import hudson.model.Action;
import hudson.model.Run;
import hudson.util.HttpResponses;
import java.io.IOException;
import net.sf.json.JSONArray;
import net.sf.json.JSONObject;
import org.kohsuke.accmod.Restricted;
import org.kohsuke.accmod.restrictions.NoExternalUse;
import org.kohsuke.stapler.HttpResponse;
import org.kohsuke.stapler.QueryParameter;
import org.kohsuke.stapler.StaplerRequest2;
import org.kohsuke.stapler.verb.GET;

/**
 * The explorer page for one build, plus the small JSON API its script uses.
 *
 * <p>Served at {@code <build>/artifact-explorer/}. {@link ArtifactExplorerFilter} forwards classic
 * {@code <build>/artifact/<dir>/} requests here so the old URL shows the explorer.
 */
public class ArtifactExplorerAction implements Action {

    /** Request attribute carrying the directory the browser originally asked for. */
    static final String PATH_ATTRIBUTE = ArtifactExplorerAction.class.getName() + ".path";

    /** Maximum number of bytes returned by {@link #doPreview(String)}. */
    static final int MAX_PREVIEW_BYTES = 128 * 1024;

    /** Largest file {@link #doSha256(String)} will hash, so one request cannot tie up the controller for long. */
    static final long MAX_SHA256_BYTES = 1024L * 1024 * 1024;

    private final Run<?, ?> run;

    public ArtifactExplorerAction(Run<?, ?> run) {
        this.run = run;
    }

    public Run<?, ?> getRun() {
        return run;
    }

    @Restricted(NoExternalUse.class) // for Jelly
    public Run<?, ?> getObject() {
        return getRun();
    }

    @Override
    public String getIconFileName() {
        // Only show the sidebar entry when there is something to explore.
        return run.getHasArtifacts() ? "symbol-cube" : null;
    }

    @Override
    public String getDisplayName() {
        return Messages.ArtifactExplorerAction_DisplayName();
    }

    @Override
    public String getUrlName() {
        return "artifact-explorer";
    }

    /** Directory to show initially: set by the filter, or given as {@code ?path=} when visited directly. */
    public String getInitialPath() {
        StaplerRequest2 req = org.kohsuke.stapler.Stapler.getCurrentRequest2();
        Object forwarded = req.getAttribute(PATH_ATTRIBUTE);
        String raw = forwarded != null ? forwarded.toString() : req.getParameter("path");
        try {
            return ArtifactTree.sanitize(raw);
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    /** URL of the build page, with a trailing slash and the context path. */
    public String getBuildUrl() {
        return org.kohsuke.stapler.Stapler.getCurrentRequest2().getContextPath() + "/" + run.getUrl();
    }

    public int getMaxEntries() {
        return ExplorerConfiguration.get().getMaxEntries();
    }

    private void checkAccess() {
        if (Functions.isArtifactsPermissionEnabled()) {
            run.checkPermission(Run.ARTIFACTS);
        } else {
            run.checkPermission(hudson.model.Item.READ);
        }
    }

    /** {@code GET tree?path=a/b}: direct children of a directory. */
    @GET
    public HttpResponse doTree(@QueryParameter String path) throws IOException {
        checkAccess();
        ArtifactTree.Listing<ArtifactTree.Entry> listing;
        try {
            listing = ArtifactTree.children(run, path, getMaxEntries());
        } catch (IllegalArgumentException e) {
            return HttpResponses.errorJSON("Invalid path");
        }
        if (listing == null) {
            return HttpResponses.errorJSON("Not a directory");
        }
        JSONArray items = new JSONArray();
        for (ArtifactTree.Entry e : listing.items()) {
            JSONObject o = new JSONObject();
            o.put("name", e.name());
            o.put("path", e.path());
            o.put("directory", e.directory());
            o.put("size", e.size());
            o.put("lastModified", e.lastModified());
            items.add(o);
        }
        JSONObject data = new JSONObject();
        data.put("entries", items);
        data.put("truncated", listing.truncated());
        return HttpResponses.okJSON(data);
    }

    /** {@code GET searchIndex}: every file path in the build, for client side search. */
    @GET
    public HttpResponse doSearchIndex() throws IOException {
        checkAccess();
        ArtifactTree.Listing<String> listing = ArtifactTree.allFiles(run, getMaxEntries());
        JSONObject data = new JSONObject();
        data.put("files", JSONArray.fromObject(listing.items()));
        data.put("truncated", listing.truncated());
        return HttpResponses.okJSON(data);
    }

    /** {@code GET preview?path=a/b.txt}: metadata and bounded UTF-8 text preview for a single file. */
    @GET
    public HttpResponse doPreview(@QueryParameter String path) throws IOException {
        checkAccess();
        ArtifactTree.FilePreview preview;
        try {
            preview = ArtifactTree.preview(run, path, MAX_PREVIEW_BYTES);
        } catch (IllegalArgumentException e) {
            return HttpResponses.errorJSON("Invalid path");
        }
        if (preview == null) {
            return HttpResponses.errorJSON("Not a file");
        }
        JSONObject data = new JSONObject();
        data.put("name", preview.name());
        data.put("path", preview.path());
        data.put("size", preview.size());
        data.put("lastModified", preview.lastModified());
        data.put("binary", preview.binary());
        data.put("truncated", preview.truncated());
        if (preview.text() != null) {
            data.put("text", preview.text());
        }
        return HttpResponses.okJSON(data);
    }

    /** {@code GET sha256?path=a/b.txt}: lowercase SHA-256 hex digest of a single file. */
    @GET
    public HttpResponse doSha256(@QueryParameter String path) throws IOException {
        checkAccess();
        String hash;
        try {
            hash = ArtifactTree.sha256(run, path, MAX_SHA256_BYTES);
        } catch (IllegalArgumentException e) {
            return HttpResponses.errorJSON("Invalid path");
        } catch (ArtifactTree.TooLargeException e) {
            return HttpResponses.errorJSON("File is too large to hash (limit 1 GiB)");
        }
        if (hash == null) {
            return HttpResponses.errorJSON("Not a file");
        }
        JSONObject data = new JSONObject();
        data.put("sha256", hash);
        return HttpResponses.okJSON(data);
    }
}
