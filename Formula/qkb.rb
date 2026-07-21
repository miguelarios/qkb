# Homebrew formula for `qkb`, wrapping the npm package `@miguelarios/qkb`
# (see .github/workflows/release.yml for how it gets published, and the
# README's "Homebrew" section for install instructions).
#
# NOT YET TAPPABLE: `sha256` below is a placeholder. The formula can only be
# validated end-to-end after the first `v*`-tag release actually publishes
# `@miguelarios/qkb` to npm (owner-only — see Task 18). Once that happens:
#   1. curl -sL https://registry.npmjs.org/@miguelarios/qkb/-/qkb-<version>.tgz | shasum -a 256
#   2. paste the digest below, replacing "REPLACE_WITH_TARBALL_SHA256"
#   3. `brew install --build-from-source Formula/qkb.rb` locally (or from a
#      `homebrew-qkb` tap repo — a single-file in-repo formula like this one
#      works with `brew install --formula ./Formula/qkb.rb` too) to smoke it.
#
# Validated so far (no Homebrew/ruby sandbox available in this environment):
#   ruby -c Formula/qkb.rb   # => "Syntax OK"
class Qkb < Formula
  desc "Hybrid BM25 + vector search for Obsidian vaults with frontmatter awareness"
  homepage "https://github.com/miguelarios/qkb"
  url "https://registry.npmjs.org/@miguelarios/qkb/-/qkb-0.1.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256" # see note above — fill in after the first npm publish
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/qkb --version")
  end
end
