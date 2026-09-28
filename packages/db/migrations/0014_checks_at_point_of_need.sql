-- Checks at the point of need (design §7.3): a lesson step's info names the check it ends with, or
-- none, instead of whether it rests on the step before. Every lesson written before this checked
-- every step; each check covers its own step, and gates when the next step rested on it.
UPDATE "learning_sessions"
SET "state" = jsonb_set(
  "state",
  '{lesson,steps}',
  (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', step->>'id',
          'check', jsonb_build_object(
            'steps', jsonb_build_array(step->>'id'),
            'terms', '[]'::jsonb,
            -- ordinality is 1-based, so element n (0-based) is the step after this one.
            'gates', coalesce(("state"->'lesson'->'steps'->(n::int))->'restsOnPrevious', 'false'::jsonb)
          )
        )
        ORDER BY n
      ),
      '[]'::jsonb
    )
    FROM jsonb_array_elements("state"->'lesson'->'steps') WITH ORDINALITY AS steps(step, n)
  )
)
WHERE jsonb_array_length("state"->'lesson'->'steps') > 0
  AND "state"->'lesson'->'steps'->0 ? 'restsOnPrevious';
