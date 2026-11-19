package() {
  cd "yazi-$CARCH-unknown-linux-gnu"
  install -Dm755 yazi ya -t "$pkgdir/usr/bin/"
  install -Dm644 completions/yazi.bash "$pkgdir/usr/share/bash-completion/completions/yazi"
  install -Dm644 completions/_yazi -t "$pkgdir/usr/share/zsh/site-functions/"
  install -Dm644 LICENSE -t "$pkgdir/usr/share/licenses/yazi/"
}
