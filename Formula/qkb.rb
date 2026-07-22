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
  url "https://registry.npmjs.org/@miguelarios/qkb/-/qkb-0.1.1.tgz"
  sha256 "ad465a61d6173dc67865ac82e90fd63a41cd59d25ed3c2b38d575c34adcfdcfc"
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
