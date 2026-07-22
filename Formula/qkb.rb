# Homebrew formula for `qkb`, wrapping the npm package `@miguelarios/qkb`
# (see .github/workflows/release.yml for how it gets published, and the
# README's "Homebrew" section for install instructions).
#
# To bump after a new npm release:
#   1. curl -sL https://registry.npmjs.org/@miguelarios/qkb/-/qkb-<version>.tgz | shasum -a 256
#   2. update `url` and `sha256` below
#   3. smoke locally: `brew install --formula ./Formula/qkb.rb`
#      (note: collides with an existing `npm i -g @miguelarios/qkb` install —
#      both want to own $(brew --prefix)/bin/qkb; use one or the other)
class Qkb < Formula
  desc "Hybrid BM25 + vector search for Obsidian vaults with frontmatter awareness"
  homepage "https://github.com/miguelarios/qkb"
  url "https://registry.npmjs.org/@miguelarios/qkb/-/qkb-0.4.0.tgz"
  sha256 "8406a771659c0dba4ec151ec0d372046288698f9ee8093ee5fe51f7a98f61b7e"
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
