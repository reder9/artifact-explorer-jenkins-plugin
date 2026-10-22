package io.jenkins.plugins.artifactexplorer;

import hudson.Extension;
import jenkins.model.GlobalConfiguration;
import jenkins.model.GlobalConfigurationCategory;
import org.jenkinsci.Symbol;
import org.kohsuke.stapler.DataBoundSetter;

/**
 * Global switches for the plugin, shown under <em>Manage Jenkins &rarr; System</em>.
 */
@Extension
@Symbol("artifactExplorer")
public final class ExplorerConfiguration extends GlobalConfiguration {

    static final int DEFAULT_MAX_ENTRIES = 5_000;
    static final int HARD_MAX_ENTRIES = 100_000;

    private boolean replaceClassicBrowser = true;
    private int maxEntries = DEFAULT_MAX_ENTRIES;

    public ExplorerConfiguration() {
        load();
    }

    public static ExplorerConfiguration get() {
        return GlobalConfiguration.all().get(ExplorerConfiguration.class);
    }

    @Override
    public GlobalConfigurationCategory getCategory() {
        return GlobalConfigurationCategory.get(GlobalConfigurationCategory.Unclassified.class);
    }

    public boolean isReplaceClassicBrowser() {
        return replaceClassicBrowser;
    }

    @DataBoundSetter
    public void setReplaceClassicBrowser(boolean replaceClassicBrowser) {
        this.replaceClassicBrowser = replaceClassicBrowser;
        save();
    }

    public int getMaxEntries() {
        return maxEntries;
    }

    @DataBoundSetter
    public void setMaxEntries(int maxEntries) {
        this.maxEntries = Math.max(1, Math.min(maxEntries, HARD_MAX_ENTRIES));
        save();
    }
}
