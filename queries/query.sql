-- Students enrolled in BOTH "Bilgisayarlı Görmenin Temelleri" AND "Veri Madenciliğine Giriş"
SELECT 
    s.ogrno,
    s.name,
    s.year,
    s.group_id
FROM students s
JOIN student_courses sc ON sc.student_id = s.id
JOIN courses c ON c.id = sc.course_id
WHERE c.course_key IN (
    'Bilgisayarlı Görmenin Temelleri (Orhan AKBULUT) (0201429_4498)',
    'Veri Madenciliğine Giriş (Sevinç İLHAN OMURCA) (0201277_2160)'
)
GROUP BY 
    s.id, 
    s.ogrno, 
    s.name, 
    s.year, 
    s.group_id
HAVING COUNT(DISTINCT c.course_key) = 2
ORDER BY s.name;