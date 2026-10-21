"""Run the whole pipeline:  python pipeline/build.py

verify CSVs (stops on failure) -> load -> tune/train/forecast -> APPEND to site/data/agricast.db
Running it again appends a new model run (and a new dataset version only if a CSV changed).
"""
import load_data
import train
import build_site_data


def main():
    df, files_info, load_report, ver = load_data.load_all()
    print("\n".join(load_report))
    print()

    result = train.run(df)
    print("\n".join(result["report"]))
    print()

    ids = build_site_data.write_database(df, files_info, ver, result)
    build_site_data.write_report(result, files_info)
    print(f"Dataset version {ids['dsv_id']} ({'new' if ids['new_dsv'] else 'already stored, reused'}); "
          f"runs {ids['run_ids']}")
    print("\n".join(build_site_data.verify(ids)))


if __name__ == "__main__":
    main()
