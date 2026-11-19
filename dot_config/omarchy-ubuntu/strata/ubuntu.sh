# Binary, icon and launcher only. The FileManager1 D-Bus service and the file
# chooser portal stay registered per account (~/.local/share), so GNOME and
# other accounts keep Nautilus.
package() {
  cd "strata-$pkgver-$CARCH-unknown-linux-gnu"
  install -Dm755 strata -t "$pkgdir/usr/bin/"
  install -Dm644 io.github.lgse.Strata.svg -t "$pkgdir/usr/share/icons/hicolor/scalable/apps/"
  sed 's|^Exec=.*strata|Exec=/usr/bin/strata|' io.github.lgse.Strata.desktop \
    | install -Dm644 /dev/stdin "$pkgdir/usr/share/applications/io.github.lgse.Strata.desktop"
  install -Dm644 LICENSE -t "$pkgdir/usr/share/licenses/strata/"
}
