CREATE TABLE "ListColumns" (
    "scope" "CustomFieldScope" NOT NULL,
    "columns" TEXT[] NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ListColumns_pkey" PRIMARY KEY ("scope"),
    CONSTRAINT "list_columns_shape" CHECK (
      cardinality("columns") BETWEEN 1 AND 12
      AND array_ndims("columns") = 1
      AND array_lower("columns", 1) = 1
      AND "columns"[1] = 'name'
      AND array_position("columns", NULL) IS NULL
    )
);
