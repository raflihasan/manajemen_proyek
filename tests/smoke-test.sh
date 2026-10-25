#!/bin/bash
# Uji fungsional aplikasi SIPM Event Kampus
BASE=http://localhost:3000
JAR=/tmp/sipm_cookies.txt
PASS=0; FAIL=0

check() { # $1 = deskripsi, $2 = kondisi (0 = ok)
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi
}

login() { # $1 = username, $2 = password
  rm -f $JAR
  curl -s -c $JAR -b $JAR -o /dev/null -X POST $BASE/login \
    -d "username=$1&password=$2"
}

status() { curl -s -o /dev/null -b $JAR -c $JAR -w "%{http_code}" "$BASE$1"; }

echo "=== 1. AUTENTIKASI & HAK AKSES ==="
rm -f $JAR
code=$(curl -s -o /dev/null -w "%{http_code}" $BASE/dashboard)
[ "$code" = "302" ] || [ "$code" = "401" ]; check "Dashboard tanpa login ditolak ($code)" $?

login admin admin123
code=$(status /dashboard); [ "$code" = "200" ]; check "Login admin -> dashboard 200 ($code)" $?
code=$(status /users); [ "$code" = "200" ]; check "Admin akses /users ($code)" $?
code=$(status /settings); [ "$code" = "200" ]; check "Admin akses /settings ($code)" $?

login manajer manajer123
code=$(status /dashboard); [ "$code" = "200" ]; check "Login manajer -> dashboard 200 ($code)" $?
code=$(status /users); [ "$code" != "200" ]; check "Manajer ditolak /users ($code)" $?
code=$(status /settings); [ "$code" != "200" ]; check "Manajer ditolak /settings ($code)" $?

login andi anggota123
code=$(status /dashboard); [ "$code" = "200" ]; check "Login anggota -> dashboard 200 ($code)" $?
code=$(status /tasks); [ "$code" = "200" ]; check "Anggota: halaman Tugas Saya tampil ($code)" $?
resp=$(curl -s -b $JAR -c $JAR $BASE/tasks | grep -c '<tr')
check "Tugas Saya menampilkan baris tugas ($resp baris)" $([ "$resp" -ge 2 ] && echo 0 || echo 1)
# anggota boleh perbarui progres tugas yang ditugaskan; ditolak untuk tugas lain
resp=$(curl -s -b $JAR -c $JAR -o /dev/null -w '%{http_code}' -X POST "$BASE/projects/1/tasks/1/progres" --data-urlencode "progress=80" --data-urlencode "status=Berjalan")
check "Anggota perbarui progres tugas yang ditugaskan ($resp)" $([ "$resp" = "302" ] && echo 0 || echo 1)
# kembalikan progres tugas demo seperti semula
resp=$(curl -s -b $JAR -c $JAR -o /dev/null -w '%{http_code}' -X POST "$BASE/projects/1/tasks/1/progres" --data-urlencode "progress=100" --data-urlencode "status=Selesai")
check "Progres tugas demo dikembalikan ke 100% ($resp)" $([ "$resp" = "302" ] && echo 0 || echo 1)
resp=$(curl -s -b $JAR -c $JAR -o /dev/null -w '%{http_code}' -X POST "$BASE/projects/1/tasks/3/progres" --data-urlencode "progress=99" --data-urlencode "status=Berjalan")
check "Anggota ditolak ubah tugas yang tidak ditugaskan ($resp)" $([ "$resp" = "403" ] && echo 0 || echo 1)
code=$(status /users); [ "$code" != "200" ]; check "Anggota ditolak /users ($code)" $?
code=$(status "/projects/999999"); [ "$code" != "200" ]; check "Akses proyek inexisten ditolak ($code)" $?

echo "=== 2. PROYEK ==="
login manajer manajer123
PID=$(curl -s -b $JAR -c $JAR $BASE/projects | grep -o 'href="/projects/[0-9]*"' | head -1 | grep -o '[0-9]*')
check "Daftar proyek menampilkan proyek demo (id=$PID)" $([ -n "$PID" ] && echo 0 || echo 1)

# buat proyek baru
curl -s -b $JAR -c $JAR -o /dev/null -X POST $BASE/projects/baru \
  --data-urlencode "name=Uji Proyek QA" --data-urlencode "organization=QA Lab" \
  --data-urlencode "description=Proyek uji otomatis" --data-urlencode "location=Gedung Uji" \
  --data-urlencode "start_date=2026-11-02" --data-urlencode "target_end_date=2026-12-20" \
  --data-urlencode "manager_id=2" --data-urlencode "status=Perencanaan"
NEWPID=$(curl -s -b $JAR -c $JAR $BASE/projects | grep -o 'Uji Proyek QA' | head -1)
check "Proyek baru tersimpan dan tampil di daftar" $([ -n "$NEWPID" ] && echo 0 || echo 1)

# validasi: target < start harus ditolak
resp=$(curl -s -b $JAR -c $JAR -X POST $BASE/projects/baru \
  --data-urlencode "name=Proyek Salah" --data-urlencode "organization=X" \
  --data-urlencode "start_date=2026-12-01" --data-urlencode "target_end_date=2026-01-01" \
  --data-urlencode "manager_id=2")
echo "$resp" | grep -qi "lebih awal\|kesalahan\|error"; check "Validasi target selesai < start ditolak" $?

echo "=== 3. KALENDER KERJA ==="
code=$(status "/projects/$PID/calendar"); [ "$code" = "200" ]; check "Halaman kalender tampil ($code)" $?
curl -s -b $JAR -c $JAR -o /dev/null -X POST "$BASE/projects/$PID/calendar/libur" \
  --data-urlencode "name=Libur Uji QA" --data-urlencode "date=2026-11-17" --data-urlencode "kind=nasional"
resp=$(curl -s -b $JAR -c $JAR "$BASE/projects/$PID/calendar?bulan=2026-11" | grep -o 'Libur Uji QA' | head -1)
check "Hari libur tersimpan dan tampil di kalender" $([ -n "$resp" ] && echo 0 || echo 1)

echo "=== 4. TUGAS ==="
code=$(status "/projects/$PID/tasks"); [ "$code" = "200" ]; check "Daftar tugas tampil ($code)" $?
curl -s -b $JAR -c $JAR -o /dev/null -X POST "$BASE/projects/$PID/tasks/baru" \
  --data-urlencode "name=Tugas Uji Pertama" --data-urlencode "duration=3" \
  --data-urlencode "start_date=2026-11-02" --data-urlencode "priority=Tinggi" \
  --data-urlencode "status=Belum Dimulai" --data-urlencode "progress=0" --data-urlencode "description=uji"
TID=$(curl -s -b $JAR -c $JAR "$BASE/projects/$PID/tasks" | grep -o 'Tugas Uji Pertama' | head -1)
check "Tugas baru tersimpan" $([ -n "$TID" ] && echo 0 || echo 1)
resp=$(curl -s -b $JAR -c $JAR "/projects/$PID/tasks" | grep -o '2026-11-0[0-9]\|2026-11-1[0-9]' | head -2 | tr '\n' ' ')
echo "  info: tanggal tugas terlihat: $resp"

echo "=== 5. DEPENDENSI ==="
curl -s -b $JAR -c $JAR -o /dev/null -X POST "$BASE/projects/$PID/tasks/baru" \
  --data-urlencode "name=Tugas Uji Kedua" --data-urlencode "duration=2" \
  --data-urlencode "start_date=2026-11-09" --data-urlencode "priority=Sedang" \
  --data-urlencode "status=Belum Dimulai" --data-urlencode "progress=0"
code=$(status "/projects/$PID/dependencies"); [ "$code" = "200" ]; check "Halaman dependensi tampil ($code)" $?

echo "=== 6. SUMBER DAYA ==="
code=$(status /resources); [ "$code" = "200" ]; check "Daftar sumber daya tampil ($code)" $?
curl -s -b $JAR -c $JAR -o /dev/null -X POST $BASE/resources/baru \
  --data-urlencode "full_name=Uji Personel" --data-urlencode "role=QA Engineer" \
  --data-urlencode "email=qa@kampus.ac.id" --data-urlencode "phone=081200000001" \
  --data-urlencode "rate=150000" --data-urlencode "rate_unit=per hari" --data-urlencode "is_active=on"
resp=$(curl -s -b $JAR -c $JAR $BASE/resources | grep -o 'Uji Personel' | head -1)
check "Anggota tim baru tersimpan" $([ -n "$resp" ] && echo 0 || echo 1)

echo "=== 7. VISUALISASI ==="
code=$(status "/projects/$PID/gantt"); [ "$code" = "200" ]; check "Gantt Chart tampil ($code)" $?
code=$(status "/projects/$PID/pert"); [ "$code" = "200" ]; check "PERT Chart tampil ($code)" $?
code=$(status "/projects/$PID/critical"); [ "$code" = "200" ]; check "Halaman jalur kritis tampil ($code)" $?
code=$(status "/projects/$PID/resource-chart"); [ "$code" = "200" ]; check "Resource Chart tampil ($code)" $?

echo "=== 8. PROYEK DEMO (data seed) ==="
code=$(status "/projects/$PID/gantt"); [ "$code" = "200" ]; check "Gantt proyek demo tampil ($code)" $?
resp=$(curl -s -b $JAR -c $JAR "$BASE/projects/$PID/critical" | grep -oi 'jalur kritis\|kritis' | head -1)
check "Analisis jalur kritis menampilkan hasil ($resp)" $([ -n "$resp" ] && echo 0 || echo 1)

echo "=== 9. LAPORAN ==="
code=$(status "/projects/$PID/report"); [ "$code" = "200" ]; check "Halaman laporan tampil ($code)" $?

echo "=== 10. PENGATURAN & PENGGUNA (admin) ==="
login admin admin123
code=$(status /users); [ "$code" = "200" ]; check "Admin: daftar pengguna tampil ($code)" $?
code=$(status "/users/baru"); [ "$code" = "200" ]; check "Admin: form pengguna baru tampil ($code)" $?
code=$(status /settings); [ "$code" = "200" ]; check "Admin: pengaturan tampil ($code)" $?

echo ""
echo "=============================="
echo "HASIL: $PASS lulus, $FAIL gagal"
echo "=============================="